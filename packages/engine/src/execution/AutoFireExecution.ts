import { TileRef } from "@openfront/engine-api/game/GameMap";
import { SiloBombs, UnitType } from "@openfront/engine-api/game/GameTypes";
import { zInt, zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { UnitTypeSchema } from "../snapshot/CommonSchemas";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { NukeExecution, WarheadType } from "./NukeExecution";

/**
 * Ticks between two auto-fired launches: a NukeExecution takes off (and puts
 * its silo tube on reload) on the tick after it is added, so waiting two
 * ticks lets the next launch pick the next loaded tube instead of failing.
 */
const MIN_TICKS_BETWEEN_LAUNCHES = 2;

/**
 * Standing fire order: keeps launching a silo bomb at one tile whenever a
 * silo tube is loaded and the player can pay for it, so a target can be
 * shelled for as long as the gold lasts. A player has at most one order; a
 * new order (or a stop, tile null) replaces it. The order ends by itself when
 * the player dies or the target tile becomes theirs or a friend's.
 */
export class AutoFireExecution implements Execution {
  private active = true;
  private mg: Game;
  private lastLaunchTick = -MIN_TICKS_BETWEEN_LAUNCHES;

  constructor(
    private player: Player,
    private unit: UnitType,
    private tile: TileRef | null,
    private rocketDirectionUp: boolean = true,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    for (const e of mg.executions()) {
      if (
        e !== this &&
        e instanceof AutoFireExecution &&
        e.player === this.player
      ) {
        e.stop();
      }
    }
    if (
      this.tile === null ||
      !SiloBombs.has(this.unit) ||
      !mg.isValidRef(this.tile) ||
      mg.config().isUnitDisabled(this.unit)
    ) {
      this.active = false;
    }
  }

  tick(ticks: number): void {
    if (!this.active || this.tile === null) {
      return;
    }
    if (!this.player.isAlive()) {
      this.active = false;
      return;
    }
    const owner = this.mg.owner(this.tile);
    if (
      owner === this.player ||
      (owner.isPlayer() && this.player.isFriendly(owner))
    ) {
      this.active = false;
      return;
    }
    if (ticks - this.lastLaunchTick < MIN_TICKS_BETWEEN_LAUNCHES) {
      return;
    }
    // No loaded tube or not enough gold yet: wait, the order stands.
    if (this.player.canBuild(this.unit, this.tile) === false) {
      return;
    }
    this.lastLaunchTick = ticks;
    this.mg.addExecution(
      new NukeExecution(
        this.unit as WarheadType,
        this.player,
        this.tile,
        null,
        -1,
        0,
        this.rocketDirectionUp,
      ),
    );
  }

  stop(): void {
    this.active = false;
  }

  owner(): Player {
    return this.player;
  }

  target(): TileRef | null {
    return this.tile;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AutoFireExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      unit: this.unit,
      tile: this.tile,
      rocketDirectionUp: this.rocketDirectionUp,
      lastLaunchTick: this.lastLaunchTick,
    });
  }

  restoreSnapshot(s: AutoFireState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.unit = s.unit;
    this.tile = s.tile;
    this.rocketDirectionUp = s.rocketDirectionUp;
    this.lastLaunchTick = s.lastLaunchTick;
  }
}

const AutoFireStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  unit: UnitTypeSchema,
  // Validated in init, so a pending execution may hold any number.
  tile: zInt().nullable(),
  rocketDirectionUp: z.boolean(),
  lastLaunchTick: zInt(),
});
type AutoFireState = z.infer<typeof AutoFireStateSchema>;

export const AutoFireExecutionSnapshot = execSnapshotType({
  name: "AutoFire",
  version: 1,
  schema: AutoFireStateSchema,
  cls: () => AutoFireExecution,
});
