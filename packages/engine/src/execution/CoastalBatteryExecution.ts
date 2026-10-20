import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { zInt, zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, isUnit, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { ShellExecution } from "./ShellExecution";

const TARGET_TYPES = [UnitType.TransportShip, UnitType.Warship] as const;

/**
 * Shore gun: shells hostile transport ships and warships that come within
 * range. One shot per level, each reloading for coastalBatteryCooldown().
 * Transport ships sink to a single shell, so the battery never spends a
 * second one on a boat it has already fired at; warships take several.
 */
export class CoastalBatteryExecution implements Execution {
  private mg: Game;
  private active = true;
  // Transport ships a shell is already flying at (they sink to one hit).
  private shelledBoats = new Set<number>();

  constructor(private battery: Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (!this.battery.isActive()) {
      this.active = false;
      return;
    }
    if (this.battery.isUnderConstruction()) {
      return;
    }

    const cooldown = this.mg.config().launcherCooldown(this.battery.type());
    const queue = this.battery.missileTimerQueue();
    while (queue.length > 0 && ticks - queue[0] >= cooldown) {
      this.battery.reloadMissile();
    }

    for (const id of this.shelledBoats) {
      if (this.mg.unit(id)?.isActive() !== true) {
        this.shelledBoats.delete(id);
      }
    }

    if (this.battery.isInCooldown()) {
      return;
    }
    // No ship on the map: skip the grid query (unitCount is memoised).
    if (
      this.mg.unitCount(UnitType.TransportShip) === 0 &&
      this.mg.unitCount(UnitType.Warship) === 0
    ) {
      return;
    }

    const owner = this.battery.owner();
    const targets = this.mg
      .nearbyUnits(
        this.battery.tile(),
        this.mg.config().coastalBatteryRange(),
        TARGET_TYPES,
        ({ unit }) =>
          isUnit(unit) &&
          unit.owner() !== owner &&
          !owner.isFriendly(unit.owner(), true) &&
          !this.shelledBoats.has(unit.id()),
      )
      .sort((a, b) => {
        // Invasion boats first, then the closest ship.
        const aBoat = a.unit.type() === UnitType.TransportShip ? 0 : 1;
        const bBoat = b.unit.type() === UnitType.TransportShip ? 0 : 1;
        if (aBoat !== bBoat) return aBoat - bBoat;
        if (a.distSquared !== b.distSquared) {
          return a.distSquared - b.distSquared;
        }
        return a.unit.id() - b.unit.id();
      });

    for (const { unit } of targets) {
      if (this.battery.isInCooldown()) {
        break;
      }
      this.battery.launch();
      this.mg.addExecution(
        new ShellExecution(this.battery.tile(), owner, this.battery, unit),
      );
      if (!unit.hasHealth()) {
        this.shelledBoats.add(unit.id());
      }
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return CoastalBatteryExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      battery: w.unit(this.battery),
      shelledBoats: [...this.shelledBoats],
    });
  }

  restoreSnapshot(s: CoastalBatteryState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.battery = r.unit(s.battery);
    this.shelledBoats = new Set(s.shelledBoats);
  }
}

const CoastalBatteryStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  battery: zRef(),
  shelledBoats: z.array(zInt()),
});
type CoastalBatteryState = z.infer<typeof CoastalBatteryStateSchema>;

export const CoastalBatteryExecutionSnapshot = execSnapshotType({
  name: "CoastalBattery",
  version: 1,
  schema: CoastalBatteryStateSchema,
  cls: () => CoastalBatteryExecution,
});
