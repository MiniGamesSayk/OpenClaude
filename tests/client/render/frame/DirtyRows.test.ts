/**
 * DirtyRows records which rows of a map-sized buffer changed, and the owners
 * of those buffers (TrailManager, RailroadCache) publish it on the buffer so
 * the uploading pass can send just the changed rows.
 */

import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import type { GameUpdateViewData } from "@openfront/engine-api/game/GameUpdates";
import { describe, expect, it } from "vitest";
import {
  DirtyRows,
  dirtyRowsOf,
} from "../../../../src/client/render/frame/DirtyRows";
import { RailroadCache } from "../../../../src/client/render/frame/RailroadCache";
import { TrailManager } from "../../../../src/client/render/frame/TrailManager";
import type { UnitState } from "../../../../src/client/render/types";
import { UT_TRADE_SHIP } from "../../../../src/client/render/types";

function runs(rows: DirtyRows, maxGap: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  rows.forEachRun(maxGap, (first, count) => out.push([first, count]));
  return out;
}

describe("DirtyRows", () => {
  it("starts clean and tracks the min/max marked row", () => {
    const rows = new DirtyRows(100);
    expect(rows.isClean).toBe(true);
    expect(rows.min).toBe(Infinity);
    expect(rows.max).toBe(-1);

    rows.mark(40);
    rows.mark(7);
    rows.mark(40);
    expect(rows.isClean).toBe(false);
    expect(rows.min).toBe(7);
    expect(rows.max).toBe(40);
    expect(runs(rows, 0)).toEqual([
      [7, 1],
      [40, 1],
    ]);
  });

  it("clear() resets flags and bounds", () => {
    const rows = new DirtyRows(50);
    rows.mark(3);
    rows.mark(20);
    rows.clear();
    expect(rows.isClean).toBe(true);
    expect(rows.min).toBe(Infinity);
    expect(rows.max).toBe(-1);
    expect(runs(rows, 8)).toEqual([]);
    expect(rows.flags.every((f) => f === 0)).toBe(true);
  });

  it("merges runs separated by fewer than maxGap clean rows", () => {
    const rows = new DirtyRows(100);
    for (const r of [10, 11, 12, 15, 30, 38, 39]) rows.mark(r);

    // Gaps are 2 rows (13-14), 14 rows (16-29) and 7 rows (31-37).
    expect(runs(rows, 1)).toEqual([
      [10, 3],
      [15, 1],
      [30, 1],
      [38, 2],
    ]);
    expect(runs(rows, 3)).toEqual([
      [10, 6],
      [30, 1],
      [38, 2],
    ]);
    expect(runs(rows, 8)).toEqual([
      [10, 6],
      [30, 10],
    ]);
    expect(runs(rows, 15)).toEqual([[10, 30]]);
  });

  it("markRange clamps to the buffer and markAll covers every row", () => {
    const rows = new DirtyRows(10);
    rows.markRange(-5, 2);
    rows.markRange(8, 99);
    expect(runs(rows, 0)).toEqual([
      [0, 3],
      [8, 2],
    ]);

    rows.clear();
    rows.markRange(6, 4); // empty
    expect(rows.isClean).toBe(true);

    rows.markAll();
    expect(runs(rows, 0)).toEqual([[0, 10]]);
  });

  it("merge copies only the flagged rows inside the given range", () => {
    const src = new DirtyRows(100);
    for (const r of [5, 20, 21, 60]) src.mark(r);

    const dst = new DirtyRows(100);
    dst.merge(src, 10, 30);
    expect(runs(dst, 0)).toEqual([[20, 2]]);

    dst.merge(src, 0, 99);
    expect(runs(dst, 0)).toEqual([
      [5, 1],
      [20, 2],
      [60, 1],
    ]);
  });
});

describe("TrailManager dirty rows", () => {
  const MAP_W = 20;
  const MAP_H = 60;

  function ship(id: number, pos: number, lastPos: number): UnitState {
    return {
      id,
      unitType: UT_TRADE_SHIP,
      ownerID: 3,
      pos,
      lastPos,
      isActive: true,
    } as UnitState;
  }

  it("publishes per-row flags on the trail state buffer", () => {
    const tm = new TrailManager(MAP_W, MAP_H);
    const rows = dirtyRowsOf(tm.getTrailState());
    expect(rows).toBeDefined();

    // Two ships far apart: rows 2 and 50 change, nothing in between.
    tm.update(
      new Map([
        [1, ship(1, 2 * MAP_W + 4, 2 * MAP_W + 4)],
        [2, ship(2, 50 * MAP_W + 9, 50 * MAP_W + 9)],
      ]),
      [1, 2],
    );
    expect(tm.dirtyRowMin).toBe(2);
    expect(tm.dirtyRowMax).toBe(50);
    expect(runs(rows!, 8)).toEqual([
      [2, 1],
      [50, 1],
    ]);

    tm.clearDirtyRows();
    expect(tm.dirtyRowMin).toBe(Infinity);
    expect(tm.dirtyRowMax).toBe(-1);
    expect(rows!.isClean).toBe(true);
  });
});

describe("RailroadCache dirty rows", () => {
  const MAP_W = 10;
  const MAP_H = 40;

  function updates(
    ...entries: Array<Record<string, unknown>>
  ): GameUpdateViewData {
    const byType: Record<number, unknown[]> = {};
    for (const e of entries) {
      (byType[e.type as number] ??= []).push(e);
    }
    return { updates: byType } as unknown as GameUpdateViewData;
  }

  /** A vertical railroad down column `x` over rows [fromRow, toRow]. */
  function column(x: number, fromRow: number, toRow: number): number[] {
    const tiles: number[] = [];
    for (let y = fromRow; y <= toRow; y++) tiles.push(y * MAP_W + x);
    return tiles;
  }

  it("flags the rows a completed (snap) railroad writes, and survives clearDirty", () => {
    const cache = new RailroadCache(MAP_W, MAP_H);
    const rows = dirtyRowsOf(cache.railroadState)!;
    expect(rows.isClean).toBe(true);

    cache.apply(
      updates({
        type: GameUpdateType.RailroadSnapEvent,
        originalId: 0,
        newId1: 1,
        newId2: 2,
        tiles1: column(3, 2, 4),
        tiles2: column(5, 30, 31),
      }),
    );
    expect(cache.railroadDirty).toBe(true);
    expect(runs(rows, 8)).toEqual([
      [2, 3],
      [30, 2],
    ]);

    // The pass clears the rows when it uploads; the per-tick flag must not.
    cache.clearDirty();
    expect(cache.railroadDirty).toBe(false);
    expect(rows.isClean).toBe(false);
  });

  it("flags animation steps only on the rows they reveal", () => {
    const cache = new RailroadCache(MAP_W, MAP_H);
    const rows = dirtyRowsOf(cache.railroadState)!;

    // 20 tiles down column 1 (rows 0-19): the first tick reveals 3 tiles from
    // each end (RAIL_INCREMENT) — rows 0-2 and 17-19.
    cache.apply(
      updates({
        type: GameUpdateType.RailroadConstructionEvent,
        id: 7,
        tiles: column(1, 0, 19),
      }),
    );
    expect(runs(rows, 1)).toEqual([
      [0, 3],
      [17, 3],
    ]);

    rows.clear();
    cache.apply(updates());
    expect(runs(rows, 1)).toEqual([
      [3, 3],
      [14, 3],
    ]);
  });

  it("flags the rows cleared by a destruction, but not tiles still shared", () => {
    const cache = new RailroadCache(MAP_W, MAP_H);
    const rows = dirtyRowsOf(cache.railroadState)!;
    cache.apply(
      updates({
        type: GameUpdateType.RailroadSnapEvent,
        originalId: 0,
        newId1: 1,
        newId2: 2,
        tiles1: column(2, 5, 7),
        // Shares tile (row 7, col 2) with the first railroad.
        tiles2: [7 * MAP_W + 2, 7 * MAP_W + 3, 7 * MAP_W + 4],
      }),
    );
    rows.clear();

    cache.apply(
      updates({ type: GameUpdateType.RailroadDestructionEvent, id: 1 }),
    );
    // Rows 5 and 6 cleared; row 7's tile at col 2 is still claimed by rail 2.
    expect(cache.railroadState[5 * MAP_W + 2]).toBe(0);
    expect(cache.railroadState[7 * MAP_W + 2]).not.toBe(0);
    expect(runs(rows, 1)).toEqual([[5, 2]]);
  });

  it("reset() flags every row, since the whole array was zeroed", () => {
    const cache = new RailroadCache(MAP_W, MAP_H);
    const rows = dirtyRowsOf(cache.railroadState)!;
    cache.reset();
    expect(runs(rows, 0)).toEqual([[0, MAP_H]]);
  });
});
