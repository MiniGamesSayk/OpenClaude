/**
 * Catching up without drawing every tick: CatchUpPacer picks the ticks the
 * client presents, and a GameView that applies ticks without presenting them
 * hands the next presented frame everything the skipped ones carried.
 */

import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { describe, expect, it } from "vitest";
import { CatchUpPacer } from "../../src/client/CatchUpPacer";
import { frame } from "./replay/util/SyntheticFrames";
import {
  makeGameView,
  makePlayerUpdate,
  makeUnitUpdate,
} from "../util/viewStubs";

describe("CatchUpPacer", () => {
  it("presents every batch while caught up", () => {
    const pacer = new CatchUpPacer(200, 2);
    for (let t = 0; t < 10; t++) {
      expect(pacer.shouldPresent(1, true, t)).toBe(true);
    }
    expect(pacer.shouldPresent(2, true, 10)).toBe(true);
  });

  it("never presents an update with more queued behind it", () => {
    const pacer = new CatchUpPacer(200, 2);
    expect(pacer.shouldPresent(1, false, 0)).toBe(false);
    expect(pacer.shouldPresent(500, false, 10_000)).toBe(false);
  });

  it("presents a few frames a second while behind, and the end", () => {
    const pacer = new CatchUpPacer(200, 2);
    const presented: number[] = [];
    // 600 ticks in 1.2 s, a batch of 4 every 8 ms, then caught up.
    for (let i = 0; i < 600; i++) {
      const pending = 600 - i;
      const now = Math.floor(i / 4) * 8;
      if (pacer.shouldPresent(pending, i % 4 === 3 || i === 599, now)) {
        presented.push(i);
      }
    }
    expect(presented.length).toBeGreaterThanOrEqual(6);
    expect(presented.length).toBeLessThanOrEqual(8);
    expect(presented[presented.length - 1]).toBe(599);
  });
});

describe("GameView ticks applied without presenting", () => {
  const player = makePlayerUpdate({ smallID: 1, id: "p1", clientID: "c1" });

  it("re-uploads everything on the next presented frame", () => {
    const view = makeGameView();
    view.update(frame(1, { updates: { [GameUpdateType.Player]: [player] } }));
    expect(view.frameData().changedTiles).toBeNull(); // first frame

    view.update(frame(2, { packedTileUpdates: new Uint32Array([3, 1]) }));
    expect(view.frameData().changedTiles).toEqual([3]);

    // Skipped: tile 4 changes and a structure appears.
    view.update(
      frame(3, {
        packedTileUpdates: new Uint32Array([4, 1]),
        updates: {
          [GameUpdateType.Unit]: [
            makeUnitUpdate({ id: 9, unitType: UnitType.City, pos: 4 }),
          ],
        },
      }),
      false,
    );
    view.update(frame(4, { packedTileUpdates: new Uint32Array([5, 1]) }));
    const fd = view.frameData();
    expect(fd.tick).toBe(4);
    expect(fd.changedTiles).toBeNull(); // full upload: tile 4 included
    expect(fd.structuresDirty).toBe(true);
    expect(fd.tileState[4]).toBe(1);
    expect(fd.units.has(9)).toBe(true);

    view.update(frame(5));
    expect(view.frameData().changedTiles).toEqual([]);
    expect(view.frameData().structuresDirty).toBe(false);
  });

  it("carries terrain changes and nuke impacts over to the presented frame", () => {
    const view = makeGameView();
    view.update(frame(1, { updates: { [GameUpdateType.Player]: [player] } }));
    // Tile 7 turns to water (terrain byte in the high bits).
    view.update(
      frame(2, {
        packedTileUpdates: new Uint32Array([7, 0x20 << 16]),
        packedNukeImpacts: new Uint32Array([7, 8]),
      }),
      false,
    );
    view.update(frame(3, { packedNukeImpacts: new Uint32Array([9]) }), false);
    view.update(frame(4));
    expect(view.recentlyUpdatedTerrainTiles()).toEqual([7]);
    expect(view.recentlyNukedTiles()).toEqual([7, 8, 9]);

    view.update(frame(5));
    expect(view.recentlyUpdatedTerrainTiles()).toEqual([]);
    expect(view.recentlyNukedTiles()).toEqual([]);
  });

  it("reports the skipped ticks' events with the presented tick", () => {
    const view = makeGameView();
    view.update(frame(1, { updates: { [GameUpdateType.Player]: [player] } }));
    const paused = { type: GameUpdateType.GamePaused, paused: true };
    const emoji = { type: GameUpdateType.Emoji, emoji: {} };
    view.update(
      frame(2, {
        updates: {
          [GameUpdateType.GamePaused]: [paused],
          [GameUpdateType.Unit]: [makeUnitUpdate({ id: 1 })],
          [GameUpdateType.Hash]: [{ type: GameUpdateType.Hash }],
        },
      }),
      false,
    );
    view.update(
      frame(3, { updates: { [GameUpdateType.Emoji]: [emoji] } }),
      false,
    );
    const unit2 = makeUnitUpdate({ id: 2 });
    view.update(frame(4, { updates: { [GameUpdateType.Unit]: [unit2] } }));

    const updates = view.updatesSinceLastTick()!;
    expect(updates[GameUpdateType.GamePaused]).toEqual([paused]);
    expect(updates[GameUpdateType.Emoji]).toEqual([emoji]);
    // Per-tick state is the presented tick's own.
    expect(updates[GameUpdateType.Unit]).toEqual([unit2]);
    expect(updates[GameUpdateType.Hash]).toEqual([]);

    // And only once.
    view.update(frame(5));
    expect(view.updatesSinceLastTick()![GameUpdateType.GamePaused]).toEqual([]);
    expect(view.updatesSinceLastTick()![GameUpdateType.Emoji]).toEqual([]);
  });

  it("takes the spawn phase's end from a resync update", () => {
    const view = makeGameView();
    view.update(frame(1, { updates: { [GameUpdateType.Player]: [player] } }));
    expect(view.inSpawnPhase()).toBe(true);
    view.update(frame(2, { viewResync: { startTick: 1 } }));
    expect(view.inSpawnPhase()).toBe(false);
    expect(view.frameData().inSpawnPhase).toBe(false);
  });
});
