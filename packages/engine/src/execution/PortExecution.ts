import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zRandom,
  zRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { TradeShipExecution } from "./TradeShipExecution";
import { TrainStationExecution } from "./TrainStationExecution";

export class PortExecution implements Execution {
  private active = true;
  private mg: Game;
  private port: Unit;
  private random: PseudoRandom;
  private checkOffset: number;
  private tradeShipSpawnRejections = 0;

  constructor(port: Unit) {
    this.port = port;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks());
    this.checkOffset = mg.ticks() % 10;
  }

  tick(ticks: number): void {
    if (this.mg === null || this.random === null || this.checkOffset === null) {
      throw new Error("Not initialized");
    }

    if (!this.port.isActive()) {
      this.active = false;
      return;
    }

    if (this.port.isUnderConstruction()) {
      return;
    }

    if (!this.port.hasTrainStation()) {
      this.createStation();
    }

    // Only check every 10 ticks for performance.
    if ((this.mg.ticks() + this.checkOffset) % 10 !== 0) {
      return;
    }

    if (!this.shouldSpawnTradeShip()) {
      return;
    }

    const port = this.pickTradingPort();
    if (port === null) {
      return;
    }
    this.mg.addExecution(
      new TradeShipExecution(this.port.owner(), this.port, port),
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  shouldSpawnTradeShip(): boolean {
    const numTradeShips = this.mg.unitCount(UnitType.TradeShip);
    const portLevels = this.port!.owner().unitCount(UnitType.Port);
    for (let i = 0; i < this.port!.level(); i++) {
      const spawnRate = this.mg
        .config()
        .tradeShipSpawnRate(
          this.tradeShipSpawnRejections,
          numTradeShips,
          portLevels,
        );
      if (this.random.chance(spawnRate)) {
        this.tradeShipSpawnRejections = 0;
        return true;
      }
      this.tradeShipSpawnRejections++;
    }
    return false;
  }

  createStation(): void {
    const nearbyFactory = this.mg.hasUnitNearby(
      this.port.tile()!,
      this.mg.config().trainStationMaxRange(),
      UnitType.Factory,
    );
    if (nearbyFactory) {
      this.mg.addExecution(new TrainStationExecution(this.port));
    }
  }

  // It's a probability list, so if an element appears twice it's because it's
  // twice more likely to be picked later.
  tradingPorts(): Unit[] {
    const weightedPorts: Unit[] = [];
    for (const { port, weight } of this.weightedTradingPorts()) {
      for (let i = 0; i < weight; i++) weightedPorts.push(port);
    }
    return weightedPorts;
  }

  /**
   * Draws a destination exactly as randElement(tradingPorts()) would — the
   * same single nextInt over the same total — without materialising the
   * expanded list, which late game (dozens of upgraded ports) runs to
   * thousands of entries per port per check.
   */
  private pickTradingPort(): Unit | null {
    const weighted = this.weightedTradingPorts();
    let total = 0;
    for (const w of weighted) total += w.weight;
    if (total === 0) {
      return null;
    }
    let idx = this.random.nextInt(0, total);
    for (const { port, weight } of weighted) {
      if (idx < weight) return port;
      idx -= weight;
    }
    throw new Error("weighted trading port pick out of range");
  }

  /**
   * Candidate destinations, nearest first, each with its number of entries in
   * the probability list (its level, once more with the proximity bonus and
   * once more when friendly).
   */
  private weightedTradingPorts(): { port: Unit; weight: number }[] {
    const sourceComponents = new Set<number>();
    for (const neighbor of this.mg.neighbors(this.port!.tile())) {
      if (!this.mg.isWater(neighbor)) continue;
      const comp = this.mg.getWaterComponent(neighbor);
      if (comp !== null) sourceComponents.add(comp);
    }
    const owner = this.port!.owner();
    const portTile = this.port!.tile();
    const candidates: { port: Unit; dist: number }[] = [];
    for (const p of this.mg.players()) {
      if (p === owner || !p.canTrade(owner)) continue;
      for (const other of p.units(UnitType.Port)) {
        for (const comp of sourceComponents) {
          if (this.mg.hasWaterComponent(other.tile(), comp)) {
            candidates.push({
              port: other,
              dist: this.mg.manhattanDist(portTile, other.tile()),
            });
            break;
          }
        }
      }
    }
    // Stable sort on the same key as before, so ties keep player order.
    candidates.sort((a, b) => a.dist - b.dist);

    const config = this.mg.config();
    const shortRange = config.tradeShipShortRangeDebuff();
    const bonusPorts = config.proximityBonusPortsNb(candidates.length);
    return candidates.map(({ port: otherPort, dist }, i) => {
      const level = otherPort.level();
      let weight = level;
      const tooClose = dist < shortRange;
      if (!tooClose && i < bonusPorts) {
        // If the port is close, but not too close, add it again
        // to increase the chances of trading with it.
        weight += level;
      }
      if (!tooClose && owner.isFriendly(otherPort.owner())) {
        weight += level;
      }
      return { port: otherPort, weight };
    });
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    const initialized = this.mg !== undefined;
    return PortExecutionSnapshot.write({
      active: this.active,
      port: w.unit(this.port),
      init: initialized
        ? { random: w.random(this.random), checkOffset: this.checkOffset }
        : null,
      tradeShipSpawnRejections: this.tradeShipSpawnRejections,
    });
  }

  restoreSnapshot(s: PortState, r: SnapshotReader): void {
    this.active = s.active;
    this.port = r.unit(s.port);
    if (s.init !== null) {
      this.mg = r.game;
      this.random = r.random(s.init.random);
      this.checkOffset = s.init.checkOffset;
    }
    this.tradeShipSpawnRejections = s.tradeShipSpawnRejections;
  }
}

const PortStateSchema = z.object({
  active: z.boolean(),
  port: zRef(),
  // Set by init.
  init: z.object({ random: zRandom(), checkOffset: zInt() }).nullable(),
  tradeShipSpawnRejections: zInt(),
});
type PortState = z.infer<typeof PortStateSchema>;

export const PortExecutionSnapshot = execSnapshotType({
  name: "Port",
  version: 1,
  schema: PortStateSchema,
  cls: () => PortExecution,
});
