/**
 * Engine side of resuming a game after a reload (see
 * tests/client/ResumeFromSnapshot.test.ts for the whole path):
 *
 *  - GameImpl.addViewResyncUpdates: the full state a fresh view needs, added
 *    to the tick that just ran, without touching the simulation;
 *  - runTicksWithinBudget: how many ticks a worker drain runs before it
 *    yields while catching up.
 */

import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  UnitUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { GameImpl } from "@openfront/engine/game/GameImpl";
import { runTicksWithinBudget } from "@openfront/engine/worker/DrainBudget";
import { describe, expect, it } from "vitest";
import { setup } from "../../util/Setup";

describe("addViewResyncUpdates", () => {
  it("sends every non-default tile, every live unit and the pause", async () => {
    const game = (await setup("plains", {
      infiniteGold: true,
      instantBuild: true,
    })) as GameImpl;
    const alice = game.addPlayer(
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
    );
    for (let x = 5; x < 15; x++) {
      for (let y = 5; y < 15; y++) alice.conquer(game.ref(x, y));
    }
    const city = alice.buildUnit(UnitType.City, game.ref(8, 8), {});
    const gone = alice.buildUnit(UnitType.DefensePost, game.ref(12, 12), {});
    gone.delete(false);
    game.setPaused(true);
    game.executeNextTick();
    game.drainPackedTileUpdates();
    const hashBefore = (game as unknown as { hash(): number }).hash();

    const updates = game.executeNextTick();
    const resync = game.addViewResyncUpdates();
    // setup() ends the spawn phase right away.
    expect(resync).toEqual({ startTick: 0 });

    const pairs = game.drainPackedTileUpdates();
    const sent = new Map<number, number>();
    for (let i = 0; i < pairs.length; i += 2) sent.set(pairs[i], pairs[i + 1]);
    let owned = 0;
    game.forEachTile((t) => {
      if (game.map().tileState(t) === 0) {
        expect(sent.has(t)).toBe(false);
        return;
      }
      owned++;
      expect(sent.get(t)! & 0xffff).toBe(game.map().tileState(t));
      expect(sent.get(t)! >>> 16).toBe(game.map().terrainByte(t));
    });
    expect(owned).toBe(100);

    const units = updates[GameUpdateType.Unit] as UnitUpdate[];
    expect(units.map((u) => u.id)).toContain(city.id());
    expect(units.some((u) => u.id === gone.id() && u.isActive)).toBe(false);
    expect(updates[GameUpdateType.GamePaused]).toEqual([
      { type: GameUpdateType.GamePaused, paused: true },
    ]);
    // A view sees the game; the game is unchanged.
    expect((game as unknown as { hash(): number }).hash()).toBe(hashBefore);
  });
});

describe("runTicksWithinBudget", () => {
  function fakeRunner(pending: number, tickMs: number, clock: { t: number }) {
    let left = pending;
    return {
      pendingTurns: () => left,
      executeNextTick: () => {
        clock.t += tickMs;
        left--;
        return true;
      },
      left: () => left,
    };
  }

  it("runs cheap ticks until the time budget is spent", () => {
    const clock = { t: 0 };
    const gr = fakeRunner(1000, 0.5, clock);
    expect(runTicksWithinBudget(gr, () => clock.t, 12, 64)).toBe(24);
  });

  it("runs at least one tick, however slow", () => {
    const clock = { t: 0 };
    const gr = fakeRunner(10, 40, clock);
    expect(runTicksWithinBudget(gr, () => clock.t, 12, 64)).toBe(1);
  });

  it("stops at the tick cap and when nothing is pending", () => {
    const clock = { t: 0 };
    expect(
      runTicksWithinBudget(fakeRunner(1000, 0, clock), () => 0, 12, 64),
    ).toBe(64);
    expect(runTicksWithinBudget(fakeRunner(3, 0, clock), () => 0, 12, 64)).toBe(
      3,
    );
    expect(runTicksWithinBudget(fakeRunner(0, 0, clock), () => 0, 12, 64)).toBe(
      0,
    );
  });

  it("stops when a tick fails", () => {
    const gr = {
      pendingTurns: () => 5,
      executeNextTick: () => false,
    };
    expect(runTicksWithinBudget(gr, () => 0)).toBe(0);
  });
});
