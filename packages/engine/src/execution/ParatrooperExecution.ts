import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { UniversalPathFinding } from "../pathfinding/PathFinder";
import { ParabolaUniversalPathFinder } from "../pathfinding/PathFinder.Parabola";
import { PathStatus } from "../pathfinding/types";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import {
  ParabolaSchema,
  parabolaState,
  restoreParabola,
} from "../snapshot/PathfinderSnapshots";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { AttackExecution } from "./AttackExecution";

/**
 * Airborne assault: a share of the player's troops flies from an airbase to
 * any land tile in range and, on landing, opens an attack from the drop zone
 * against whoever owns it — an invasion that needs neither a shared border
 * nor a coast. Landing on a tile that turned friendly in the meantime
 * returns the troops home.
 */
export class ParatrooperExecution implements Execution {
  private active = true;
  private mg: Game;
  private plane: Unit | null = null;
  private src: TileRef | null = null;
  private speed = 0;
  private pathFinder: ParabolaUniversalPathFinder;

  constructor(
    private player: Player,
    private dst: TileRef,
    private troops: number | null = null,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.speed = mg.config().paratrooperSpeed();
    this.pathFinder = UniversalPathFinding.Parabola(mg, {
      increment: this.speed,
    });
  }

  tick(ticks: number): void {
    if (this.plane === null) {
      this.launch(ticks);
      return;
    }
    if (!this.plane.isActive()) {
      this.active = false;
      return;
    }

    const result = this.pathFinder.next(this.src!, this.dst, this.speed);
    if (result.status === PathStatus.NEXT) {
      this.plane.move(result.node);
      this.plane.setTrajectoryIndex(this.pathFinder.currentIndex());
      return;
    }
    if (result.status === PathStatus.COMPLETE) {
      this.plane.move(result.node);
    }
    this.land();
  }

  private launch(ticks: number): void {
    const airbaseTile = this.player.canBuild(UnitType.Paratroopers, this.dst);
    if (airbaseTile === false) {
      console.warn(`cannot drop paratroopers`);
      this.active = false;
      return;
    }
    const airbase = this.player
      .units(UnitType.Airbase)
      .find((a) => a.tile() === airbaseTile);
    const wanted =
      this.troops ??
      Math.floor(
        this.player.troops() * this.mg.config().paratrooperTroopShare(),
      );
    const troops = Math.floor(Math.min(wanted, this.player.troops()));
    if (troops <= 0) {
      this.active = false;
      return;
    }

    // buildUnit charges the gold and takes the troops aboard.
    this.src = airbaseTile;
    this.plane = this.player.buildUnit(UnitType.Paratroopers, airbaseTile, {
      targetTile: this.dst,
      trajectory: (this.pathFinder.findPath(airbaseTile, this.dst) ?? []).map(
        (tile) => ({ tile, targetable: false }),
      ),
      troops,
    });
    this.plane.setTargetable(false);
    airbase?.launch();
    this.recordMotionPlan(ticks);

    const target = this.mg.owner(this.dst);
    if (target.isPlayer()) {
      this.mg.displayIncomingUnit(
        this.plane.id(),
        "events_display.paratroopers_inbound",
        MessageType.NAVAL_INVASION_INBOUND,
        target.id(),
      );
    }
  }

  /** Same contract as NukeExecution.recordMotionPlan: the exact tile sequence. */
  private recordMotionPlan(ticks: number): void {
    if (this.plane === null || this.src === null) return;
    const pathFinder = UniversalPathFinding.Parabola(this.mg, {
      increment: this.speed,
    });
    const path: TileRef[] = [this.src];
    let result = pathFinder.next(this.src, this.dst, this.speed);
    while (result.status === PathStatus.NEXT) {
      path.push(result.node);
      result = pathFinder.next(this.src, this.dst, this.speed);
    }
    this.mg.recordMotionPlan({
      kind: "grid",
      unitId: this.plane.id(),
      planId: 1,
      startTick: ticks + 1,
      ticksPerStep: 1,
      path,
    });
  }

  private land(): void {
    const plane = this.plane!;
    const troops = plane.troops();
    const target = this.mg.owner(this.dst);
    this.active = false;
    plane.setReachedTarget();
    plane.delete(false);

    if (
      target === this.player ||
      (target.isPlayer() && !this.player.canAttackPlayer(target)) ||
      !this.mg.isLand(this.dst)
    ) {
      // Nothing to fight here any more: the troops rejoin the army.
      this.player.addTroops(troops);
      return;
    }
    this.player.conquer(this.dst);
    this.mg.addExecution(
      new AttackExecution(troops, this.player, target.id(), this.dst, false),
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ParatrooperExecutionSnapshot.write({
      active: this.active,
      pathFinder: this.mg === undefined ? null : parabolaState(this.pathFinder),
      player: w.player(this.player),
      dst: this.dst,
      troops: this.troops,
      plane: w.unitOrNull(this.plane),
      src: this.src,
      speed: this.speed,
    });
  }

  restoreSnapshot(s: ParatrooperState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.pathFinder !== null) {
      this.mg = r.game;
      this.pathFinder = restoreParabola(r.game, s.pathFinder);
    }
    this.player = r.player(s.player);
    this.dst = s.dst;
    this.troops = s.troops;
    this.plane = r.unitOrNull(s.plane);
    this.src = s.src;
    this.speed = s.speed;
  }
}

const ParatrooperStateSchema = z.object({
  active: z.boolean(),
  pathFinder: ParabolaSchema.nullable(),
  player: zPlayerRef(),
  dst: zTile(),
  troops: zInt().nullable(),
  plane: zRef().nullable(),
  src: zTile().nullable(),
  speed: zNum(),
});
type ParatrooperState = z.infer<typeof ParatrooperStateSchema>;

export const ParatrooperExecutionSnapshot = execSnapshotType({
  name: "Paratrooper",
  version: 1,
  schema: ParatrooperStateSchema,
  cls: () => ParatrooperExecution,
});
