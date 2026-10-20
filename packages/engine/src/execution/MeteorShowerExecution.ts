import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  Nukes,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { MUTATOR_DEFAULTS } from "@openfront/engine-lib/configuration/Config";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { zInt, zRandom } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

// Matches NukeExecution: structures this close to the blast get redrawn.
const SPRITE_RADIUS = 16;
// Random draws per meteor before giving up on finding a land tile.
const MAX_TARGET_TRIES = 64;

/**
 * Meteor Shower mutator. Once spawn immunity and a grace period are over, a
 * volley of meteors crashes on random land tiles every
 * meteorMinIntervalSeconds..meteorMaxIntervalSeconds. Each impact blasts a
 * crater like a small atom bomb: the tiles are lost (fallout, or water with
 * water nukes), the owner loses troops, and every unit in the crater is
 * destroyed. Meteors belong to nobody: they can't be intercepted, never break
 * alliances and credit no kills.
 *
 * Deterministic: targets and timings come from a PRNG seeded from the game id,
 * and the crater shape from the same PRNG.
 */
export class MeteorShowerExecution implements Execution {
  private active = true;
  private mg: Game | null = null;
  private random: PseudoRandom;
  // Tick of the next volley, or -1 until scheduled on the first tick.
  private nextVolleyTick = -1;

  constructor(seed: number) {
    this.random = new PseudoRandom(seed);
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    const mg = this.mg;
    if (mg === null) throw new Error("Not initialized");
    if (this.nextVolleyTick === -1) {
      // Seconds since the spawn phase ended; the first volley waits out
      // spawn immunity plus the grace period.
      const elapsedTicks = Math.floor(mg.elapsedGameSeconds() * 10);
      const firstVolley =
        mg.config().spawnImmunityDuration() +
        MUTATOR_DEFAULTS.meteorGraceSeconds * 10;
      this.nextVolleyTick = ticks + Math.max(0, firstVolley - elapsedTicks);
      return;
    }
    if (ticks < this.nextVolleyTick) return;

    const count = meteorsPerVolley(mg.numLandTiles());
    for (let i = 0; i < count; i++) {
      const target = this.pickTarget(mg);
      if (target !== null) this.strike(mg, target);
    }
    this.nextVolleyTick =
      ticks +
      this.random.nextInt(
        MUTATOR_DEFAULTS.meteorMinIntervalSeconds * 10,
        MUTATOR_DEFAULTS.meteorMaxIntervalSeconds * 10 + 1,
      );
  }

  private pickTarget(mg: Game): TileRef | null {
    for (let i = 0; i < MAX_TARGET_TRIES; i++) {
      const tile = mg.ref(
        this.random.nextInt(0, mg.width()),
        this.random.nextInt(0, mg.height()),
      );
      if (mg.isLand(tile) && !mg.isImpassable(tile)) return tile;
    }
    return null;
  }

  private strike(mg: Game, center: TileRef): void {
    const inner = MUTATOR_DEFAULTS.meteorInnerRadius;
    const outer = MUTATOR_DEFAULTS.meteorOuterRadius;
    const inner2 = inner * inner;
    const outer2 = outer * outer;
    const crater = mg.bfs(center, (_, n: TileRef) => {
      const d2 = mg.euclideanDistSquared(center, n);
      return (
        d2 <= outer2 &&
        (d2 <= inner2 || this.random.chance(2)) &&
        !mg.isImpassable(n)
      );
    });

    const tilesLost = new Map<Player, number>();
    for (const tile of crater) {
      const owner = mg.owner(tile);
      if (owner.isPlayer()) {
        owner.relinquish(tile);
        tilesLost.set(owner, (tilesLost.get(owner) ?? 0) + 1);
      }
      if (mg.isLand(tile)) {
        mg.queueWaterConversion(tile);
      }
      mg.queueNukeImpact(tile);
    }

    // Troops die like under an atom bomb: each lost tile kills a share of
    // the army that grows as the territory shrinks.
    const config = mg.config();
    for (const [player, lost] of tilesLost) {
      const tilesBefore = player.numTilesOwned() + lost;
      const maxTroops = config.maxTroops(player);
      for (let i = 0; i < lost; i++) {
        player.removeTroops(
          config.nukeDeathFactor(
            UnitType.AtomBomb,
            player.troops(),
            tilesBefore - i,
            maxTroops,
          ),
        );
      }
      mg.displayMessage(
        "events_display.meteor_impact",
        MessageType.NUKE_DETONATED,
        player.id(),
        undefined,
        { tiles: lost },
      );
    }

    const hit = mg.nearbyUnits(
      center,
      outer,
      ALL_GROUND_UNITS,
      undefined,
      true,
    );
    for (const { unit } of hit) {
      unit.delete(true);
    }

    const redraw = outer + SPRITE_RADIUS;
    const nearby = mg.nearbyUnits(
      center,
      redraw,
      Structures.types,
      undefined,
      true,
    );
    for (const { unit } of nearby) {
      unit.touch();
    }

    mg.addUpdate({
      type: GameUpdateType.MeteorImpact,
      tile: center,
      radius: outer,
    });
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return MeteorShowerExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== null,
      random: w.random(this.random),
      nextVolleyTick: this.nextVolleyTick,
    });
  }

  restoreSnapshot(s: MeteorShowerState, r: SnapshotReader): void {
    this.active = s.active;
    this.mg = s.initialized ? r.game : null;
    this.random = r.random(s.random);
    this.nextVolleyTick = s.nextVolleyTick;
  }
}

// Every unit a meteor can destroy: anything but missiles in flight.
const ALL_GROUND_UNITS: readonly UnitType[] = Object.values(UnitType).filter(
  (type) =>
    !Nukes.has(type) && type !== UnitType.SAMMissile && type !== UnitType.Shell,
);

/** Meteors per volley: one, plus one per meteorLandTilesPerMeteor land tiles. */
export function meteorsPerVolley(numLandTiles: number): number {
  return Math.min(
    MUTATOR_DEFAULTS.meteorMaxPerVolley,
    1 + Math.floor(numLandTiles / MUTATOR_DEFAULTS.meteorLandTilesPerMeteor),
  );
}

const MeteorShowerStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  random: zRandom(),
  nextVolleyTick: zInt(),
});
type MeteorShowerState = z.infer<typeof MeteorShowerStateSchema>;

export const MeteorShowerExecutionSnapshot = execSnapshotType({
  name: "MeteorShower",
  version: 1,
  schema: MeteorShowerStateSchema,
  cls: () => MeteorShowerExecution,
});
