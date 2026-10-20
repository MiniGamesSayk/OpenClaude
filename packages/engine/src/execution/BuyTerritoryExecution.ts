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

  snapshot(w: SnapshotWriter): ExecRecord {
    if (this.target === undefined) {
      throw new Error("cannot snapshot territory purchase without target");
    }
    return BuyTerritoryExecutionSnapshot.write({
      player: w.player(this.player),
      targetID: w.player(this.target),
    });
  }

  restoreSnapshot(s: BuyTerritoryState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.target = r.player(s.targetID);
    this.targetID = this.target.id();
  }
}

const BuyTerritoryStateSchema = z.object({
  player: zPlayerRef(),
  targetID: zPlayerRef(),
});
type BuyTerritoryState = z.infer<typeof BuyTerritoryStateSchema>;

export const BuyTerritoryExecutionSnapshot = execSnapshotType({
  name: "BuyTerritory",
  version: 1,
  schema: BuyTerritoryStateSchema,
  cls: () => BuyTerritoryExecution,
});
