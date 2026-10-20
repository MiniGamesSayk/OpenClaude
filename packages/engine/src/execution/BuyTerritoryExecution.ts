import { PlayerID } from "@openfront/engine-api/game/GameTypes";
import { zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

export class BuyTerritoryExecution implements Execution {
  private active = true;
  private target: Player | undefined;

  constructor(
    private player: Player,
    private targetID: PlayerID,
  ) {}

  init(mg: Game): void {
    if (mg.hasPlayer(this.targetID)) this.target = mg.player(this.targetID);
  }

  tick(): void {
    if (this.target !== undefined && this.player.canBuyTerritory(this.target)) {
      const cost = this.player.territoryPurchaseCost(this.target);
      this.player.removeGold(cost);
      for (const tile of [...this.target.tiles()]) this.player.conquer(tile);
      for (const unit of this.target.units()) {
        if (unit.isActive()) unit.setOwner(this.player);
      }
    }
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  // A pending purchase (queued during the spawn phase) has no resolved
  // target yet, so the target is stored by id and resolved again on restore.
  snapshot(w: SnapshotWriter): ExecRecord {
    return BuyTerritoryExecutionSnapshot.write({
      player: w.player(this.player),
      targetID: this.targetID,
      resolved: this.target !== undefined,
    });
  }

  restoreSnapshot(s: BuyTerritoryState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.targetID = s.targetID;
    this.target =
      s.resolved && r.game.hasPlayer(s.targetID)
        ? r.game.player(s.targetID)
        : undefined;
  }
}

const BuyTerritoryStateSchema = z.object({
  player: zPlayerRef(),
  targetID: z.string(),
  resolved: z.boolean(),
});
type BuyTerritoryState = z.infer<typeof BuyTerritoryStateSchema>;

export const BuyTerritoryExecutionSnapshot = execSnapshotType({
  name: "BuyTerritory",
  version: 1,
  schema: BuyTerritoryStateSchema,
  cls: () => BuyTerritoryExecution,
});
