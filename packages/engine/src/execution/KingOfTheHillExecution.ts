import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  ColoredTeams,
  GameMode,
  MessageType,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  HillScore,
} from "@openfront/engine-api/game/GameUpdates";
import { MUTATOR_DEFAULTS } from "@openfront/engine-lib/configuration/Config";
import {
  zInt,
  zTile,
  zTiles,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

// How many sides the HUD's leaderboard shows.
const MAX_LEADERS = 3;

/**
 * King of the Hill mutator. A circular hill sits on the land tile closest to
 * the middle of the map. It opens hillOpenSeconds after the spawn phase; from
 * then on, once a second, the side (a player in FFA, a team otherwise) owning
 * MORE than hillControlPercent of the hill's land controls it and banks a
 * second. The first side to bank hillHoldSecondsToWin seconds wins the game.
 * The usual win conditions still apply alongside.
 *
 * Tribes (bot players) and the bot team can block the hill but never control
 * it. Fallout and water-converted tiles leave the count, so a nuked hill is
 * easier to take back.
 *
 * Deterministic: integer counts only. Runs once per second, like
 * WinCheckExecution.
 */
export class KingOfTheHillExecution implements Execution {
  private active = true;
  private mg: Game | null = null;
  private center: TileRef = 0;
  private radius = 0;
  private hillTiles: TileRef[] = [];
  // Hold time per side, in seconds, in first-capture order.
  private scores = new Map<string, number>();
  private holder: string | null = null;
  private announcedOpen = false;

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.center = findHillCenter(mg);
    this.radius = hillRadius(mg.numLandTiles());
    this.hillTiles = hillTiles(mg, this.center, this.radius);
  }

  tick(ticks: number): void {
    if (ticks % 10 !== 0) return;
    const mg = this.mg;
    if (mg === null) throw new Error("Not initialized");
    if (mg.getWinner() !== null) {
      this.active = false;
      return;
    }

    const opensIn = Math.max(
      0,
      MUTATOR_DEFAULTS.hillOpenSeconds - Math.floor(mg.elapsedGameSeconds()),
    );
    if (opensIn === 0) {
      if (!this.announcedOpen) {
        this.announcedOpen = true;
        mg.displayMessage(
          "events_display.hill_open",
          MessageType.CONQUERED_PLAYER,
          null,
        );
      }
      this.updateHolder(mg);
      if (this.holder !== null) {
        const held = (this.scores.get(this.holder) ?? 0) + 1;
        this.scores.set(this.holder, held);
        if (held >= MUTATOR_DEFAULTS.hillHoldSecondsToWin) {
          this.declareWinner(mg, this.holder);
        }
      }
    }
    this.emitUpdate(mg, opensIn);
  }

  private isTeamGame(mg: Game): boolean {
    return mg.config().gameConfig().gameMode === GameMode.Team;
  }

  // The side a player plays for, or null when it can never control the hill.
  private sideOf(mg: Game, player: Player): string | null {
    if (player.type() === PlayerType.Bot) return null;
    if (!this.isTeamGame(mg)) return player.id();
    const team = player.team();
    if (team === null || team === ColoredTeams.Bot) return null;
    return team;
  }

  private updateHolder(mg: Game): void {
    let land = 0;
    const ownedBySmallID = new Map<number, number>();
    for (const tile of this.hillTiles) {
      if (!mg.isLand(tile) || mg.hasFallout(tile)) continue;
      land++;
      const owner = mg.ownerID(tile);
      if (owner !== 0) {
        ownedBySmallID.set(owner, (ownedBySmallID.get(owner) ?? 0) + 1);
      }
    }
    const bySide = new Map<string, number>();
    for (const [smallID, count] of ownedBySmallID) {
      const player = mg.playerBySmallID(smallID);
      if (!player.isPlayer()) continue;
      const side = this.sideOf(mg, player);
      if (side === null) continue;
      bySide.set(side, (bySide.get(side) ?? 0) + count);
    }
    let holder: string | null = null;
    for (const [side, count] of bySide) {
      if (count * 100 > land * MUTATOR_DEFAULTS.hillControlPercent) {
        holder = side;
      }
    }
    if (holder !== null && holder !== this.holder) {
      mg.displayMessage(
        "events_display.hill_captured",
        MessageType.CONQUERED_PLAYER,
        null,
        undefined,
        { name: this.sideName(mg, holder) },
      );
    }
    this.holder = holder;
  }

  private sideName(mg: Game, side: string): string {
    return this.isTeamGame(mg) ? side : mg.player(side).displayName();
  }

  private declareWinner(mg: Game, side: string): void {
    const winner = this.isTeamGame(mg) ? side : mg.player(side);
    mg.setWinner(winner, mg.stats().stats());
    console.log(`${side} has won the game by holding the hill`);
    this.active = false;
  }

  private emitUpdate(mg: Game, opensInSeconds: number): void {
    const leaders: HillScore[] = [...this.scores]
      .map(([side, seconds]) => ({ side, seconds }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, MAX_LEADERS);
    mg.addUpdate({
      type: GameUpdateType.KingOfTheHill,
      centerTile: this.center,
      radius: this.radius,
      opensInSeconds,
      holder: this.holder,
      isTeamGame: this.isTeamGame(mg),
      secondsToWin: MUTATOR_DEFAULTS.hillHoldSecondsToWin,
      leaders,
    });
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return KingOfTheHillExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== null,
      center: this.center,
      radius: this.radius,
      hillTiles: w.tiles(this.hillTiles),
      scoreSides: [...this.scores.keys()],
      scoreSeconds: [...this.scores.values()],
      holder: this.holder,
      announcedOpen: this.announcedOpen,
    });
  }

  restoreSnapshot(s: KingOfTheHillState, r: SnapshotReader): void {
    this.active = s.active;
    this.mg = s.initialized ? r.game : null;
    this.center = s.center;
    this.radius = s.radius;
    this.hillTiles = Array.from(s.hillTiles);
    this.scores = new Map(
      s.scoreSides.map((side, i) => [side, s.scoreSeconds[i]]),
    );
    this.holder = s.holder;
    this.announcedOpen = s.announcedOpen;
  }
}

/** Hill radius in tiles: grows with the square root of the land area. */
export function hillRadius(numLandTiles: number): number {
  return Math.min(
    MUTATOR_DEFAULTS.hillMaxRadius,
    Math.max(
      MUTATOR_DEFAULTS.hillMinRadius,
      Math.floor(Math.sqrt(numLandTiles) / 25),
    ),
  );
}

/**
 * The passable land tile closest to the middle of the map (lowest tile ref
 * on ties). Scans the map once, at game start.
 */
export function findHillCenter(mg: Game): TileRef {
  const cx = Math.floor(mg.width() / 2);
  const cy = Math.floor(mg.height() / 2);
  let best: TileRef = mg.ref(cx, cy);
  let bestDist = Infinity;
  for (let y = 0; y < mg.height(); y++) {
    const dy = y - cy;
    if (dy * dy >= bestDist) continue;
    for (let x = 0; x < mg.width(); x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 >= bestDist) continue;
      const tile = mg.ref(x, y);
      if (!mg.isLand(tile) || mg.isImpassable(tile)) continue;
      best = tile;
      bestDist = d2;
    }
  }
  return best;
}

/** Passable land tiles within `radius` of `center`. */
export function hillTiles(
  mg: Game,
  center: TileRef,
  radius: number,
): TileRef[] {
  const cx = mg.x(center);
  const cy = mg.y(center);
  const r2 = radius * radius;
  const tiles: TileRef[] = [];
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(mg.height() - 1, cy + radius);
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(mg.width() - 1, cx + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const tile = mg.ref(x, y);
      if (mg.isLand(tile) && !mg.isImpassable(tile)) tiles.push(tile);
    }
  }
  return tiles;
}

const KingOfTheHillStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  center: zTile(),
  radius: zInt(),
  hillTiles: zTiles(),
  // Hold time per side, as parallel arrays in first-capture order.
  scoreSides: z.array(z.string()),
  scoreSeconds: z.array(zInt()),
  holder: z.string().nullable(),
  announcedOpen: z.boolean(),
});
type KingOfTheHillState = z.infer<typeof KingOfTheHillStateSchema>;

export const KingOfTheHillExecutionSnapshot = execSnapshotType({
  name: "KingOfTheHill",
  version: 1,
  schema: KingOfTheHillStateSchema,
  cls: () => KingOfTheHillExecution,
});
