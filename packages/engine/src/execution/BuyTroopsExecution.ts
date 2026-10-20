import { zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

const GOLD_PER_PURCHASE = 1_000n;
const TROOPS_PER_PURCHASE = 10_000;

export class BuyTroopsExecution implements Execution {
  private active = true;
  private mg: Game;

  constructor(private player: Player) {}

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(): void {
    const affordablePurchases = this.player.gold() / GOLD_PER_PURCHASE;
    const availableTroops = Math.max(
      0,
      this.mg.config().maxTroops(this.player) - this.player.troops(),
    );
    const purchases = Math.min(
      Number(affordablePurchases),
      Math.ceil(availableTroops / TROOPS_PER_PURCHASE),
    );
    if (purchases > 0) {
      this.player.removeGold(BigInt(purchases) * GOLD_PER_PURCHASE);
      this.player.addTroops(
        Math.min(availableTroops, purchases * TROOPS_PER_PURCHASE),
      );
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
    return BuyTroopsExecutionSnapshot.write({ player: w.player(this.player) });
  }

  restoreSnapshot(s: BuyTroopsState, r: SnapshotReader): void {
    this.player = r.player(s.player);
  }
}

const BuyTroopsStateSchema = z.object({ player: zPlayerRef() });
type BuyTroopsState = z.infer<typeof BuyTroopsStateSchema>;

export const BuyTroopsExecutionSnapshot = execSnapshotType({
  name: "BuyTroops",
  version: 1,
  schema: BuyTroopsStateSchema,
  cls: () => BuyTroopsExecution,
});
