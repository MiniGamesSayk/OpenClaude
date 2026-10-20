import {
  ColoredTeams,
  GameMode,
  MessageType,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { MUTATOR_DEFAULTS } from "@openfront/engine-lib/configuration/Config";
import { zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type { ExecRecord, SnapshotReader } from "../snapshot/SnapshotContext";

/**
 * Underdog mutator (comeback mechanic). Once a second, every side (a player
 * in FFA, a team otherwise) holding less than underdogLeaderPercent of the
 * leading side's tiles is an underdog: each of its human and nation players
 * earns underdogBonusPercent extra on top of its normal troop and gold
 * income, so a crushed side can rebuild and strike back. Tribes never get the
 * bonus. A player is told once each time it becomes an underdog.
 *
 * Deterministic: integer tile counts and floored bonuses. Runs once per
 * second (every 10 ticks), so the bonus is ten ticks' worth of income.
 */
export class UnderdogExecution implements Execution {
  private active = true;
  private mg: Game | null = null;
  // Small ids of the players currently receiving the bonus.
  private underdogs = new Set<number>();

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (ticks % 10 !== 0) return;
    const mg = this.mg;
    if (mg === null) throw new Error("Not initialized");

    const contenders = mg
      .players()
      .filter(
        (p) => p.type() !== PlayerType.Bot && p.team() !== ColoredTeams.Bot,
      );
    const teamGame = mg.config().gameConfig().gameMode === GameMode.Team;
    const sideTiles = new Map<string, number>();
    for (const p of contenders) {
      const side = sideOf(p, teamGame);
      sideTiles.set(side, (sideTiles.get(side) ?? 0) + p.numTilesOwned());
    }
    let leaderTiles = 0;
    for (const tiles of sideTiles.values()) {
      leaderTiles = Math.max(leaderTiles, tiles);
    }

    const config = mg.config();
    const bonus = MUTATOR_DEFAULTS.underdogBonusPercent;
    const next = new Set<number>();
    for (const p of contenders) {
      const tiles = sideTiles.get(sideOf(p, teamGame)) ?? 0;
      if (
        tiles === 0 ||
        tiles * 100 >= leaderTiles * MUTATOR_DEFAULTS.underdogLeaderPercent
      ) {
        continue;
      }
      next.add(p.smallID());
      if (!this.underdogs.has(p.smallID())) {
        mg.displayMessage(
          "events_display.underdog_bonus",
          MessageType.DONATION_RECEIVED,
          p.id(),
          undefined,
          { percent: bonus },
        );
      }
      const troops = Math.floor(
        (config.troopIncreaseRate(p) * 10 * bonus) / 100,
      );
      if (troops > 0) p.addTroops(troops);
      const gold = (config.goldAdditionRate(p) * 10n * BigInt(bonus)) / 100n;
      if (gold > 0n) p.addGold(gold);
    }
    this.underdogs = next;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(): ExecRecord {
    return UnderdogExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== null,
      underdogs: [...this.underdogs],
    });
  }

  restoreSnapshot(s: UnderdogState, r: SnapshotReader): void {
    this.active = s.active;
    this.mg = s.initialized ? r.game : null;
    this.underdogs = new Set(s.underdogs);
  }
}

function sideOf(player: Player, teamGame: boolean): string {
  return teamGame ? (player.team() ?? player.id()) : player.id();
}

const UnderdogStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  underdogs: z.array(zPlayerRef()),
});
type UnderdogState = z.infer<typeof UnderdogStateSchema>;

export const UnderdogExecutionSnapshot = execSnapshotType({
  name: "Underdog",
  version: 1,
  schema: UnderdogStateSchema,
  cls: () => UnderdogExecution,
});
