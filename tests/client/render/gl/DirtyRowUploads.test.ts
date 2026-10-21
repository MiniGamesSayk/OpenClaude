/**
 * Partial texture uploads (TrailPass, RailroadPass) and the rail ghost diff.
 *
 * The passes are exercised through their prototypes with a recording GL stub:
 * the real flush/diff code runs, only the GL calls it makes are captured.
 */

import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import type { GameUpdateViewData } from "@openfront/engine-api/game/GameUpdates";
import { describe, expect, it, vi } from "vitest";
import {
  DirtyRows,
  dirtyRowsOf,
} from "../../../../src/client/render/frame/DirtyRows";
import { RailroadCache } from "../../../../src/client/render/frame/RailroadCache";
import { TrailManager } from "../../../../src/client/render/frame/TrailManager";
import { RailroadPass } from "../../../../src/client/render/gl/passes/RailroadPass";
import { TrailPass } from "../../../../src/client/render/gl/passes/TrailPass";
import type {
  GhostPreviewData,
  UnitState,
} from "../../../../src/client/render/types";
import { UT_TRADE_SHIP } from "../../../../src/client/render/types";

const MAP_W = 20;
const MAP_H = 100;

interface Upload {
  yoffset: number;
  width: number;
  height: number;
  data: ArrayBufferView;
}

function makeGl() {
  const uploads: Upload[] = [];
  const gl = {
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    RED_INTEGER: 0x8d94,
    UNSIGNED_SHORT: 0x1403,
    UNSIGNED_BYTE: 0x1401,
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texSubImage2D: vi.fn(
      (
        _target: number,
        _level: number,
        _x: number,
        yoffset: number,
        width: number,
        height: number,
        _format: number,
        _type: number,
        data: ArrayBufferView,
      ) => {
        uploads.push({ yoffset, width, height, data });
      },
    ),
  };
  return { gl, uploads };
}

function ship(id: number, row: number): UnitState {
  const pos = row * MAP_W + 3;
  return {
    id,
    unitType: UT_TRADE_SHIP,
    ownerID: 1,
    pos,
    lastPos: pos,
    isActive: true,
  } as UnitState;
}

describe("TrailPass partial upload", () => {
  function makePass(gl: unknown): TrailPass {
    const pass = Object.create(TrailPass.prototype) as TrailPass;
    Object.assign(pass, {
      gl,
      mapW: MAP_W,
      mapH: MAP_H,
      trailTex: {},
      dirtyRows: new DirtyRows(MAP_H),
      fullUploadPending: false,
      trailsDirty: false,
      liveTrailRef: null,
    });
    return pass;
  }

  /** One game tick with these ships alive, then the delta handed to the pass. */
  function tick(
    pass: TrailPass,
    tm: TrailManager,
    ...ships: UnitState[]
  ): void {
    tm.clearDirtyRows();
    tm.update(
      new Map(ships.map((s) => [s.id, s] as const)),
      ships.map((s) => s.id),
    );
    pass.applyLiveDelta(tm.getTrailState(), tm.dirtyRowMin, tm.dirtyRowMax);
  }

  it("uploads each run of dirty rows, merging near rows and skipping far gaps", () => {
    const { gl, uploads } = makeGl();
    const pass = makePass(gl);
    const tm = new TrailManager(MAP_W, MAP_H);

    // Rows 10 and 14 are 3 clean rows apart (merged); row 80 is far away.
    tick(pass, tm, ship(1, 10), ship(2, 14), ship(3, 80));
    pass.flushTexture();

    expect(uploads.map((u) => [u.yoffset, u.height])).toEqual([
      [10, 5],
      [80, 1],
    ]);
    for (const u of uploads) {
      expect(u.width).toBe(MAP_W);
      const data = u.data as Uint16Array;
      expect(data.length).toBe(u.height * MAP_W);
      expect(data.byteOffset).toBe(u.yoffset * MAP_W * 2);
      expect(data.buffer).toBe(tm.getTrailState().buffer);
    }

    // Flushed: nothing more to send until the next delta.
    pass.flushTexture();
    expect(uploads).toHaveLength(2);
  });

  it("accumulates rows from several ticks between flushes", () => {
    const { gl, uploads } = makeGl();
    const pass = makePass(gl);
    const tm = new TrailManager(MAP_W, MAP_H);

    const first = ship(1, 5);
    tick(pass, tm, first);
    // TrailManager cleared its rows for this tick; the pass kept row 5.
    tick(pass, tm, first, ship(2, 60));
    pass.flushTexture();

    expect(uploads.map((u) => [u.yoffset, u.height])).toEqual([
      [5, 1],
      [60, 1],
    ]);
  });

  it("sends the whole array after setLiveRef, even with a delta pending", () => {
    const { gl, uploads } = makeGl();
    const pass = makePass(gl);
    const tm = new TrailManager(MAP_W, MAP_H);

    const first = ship(1, 5);
    const second = ship(2, 60);
    tick(pass, tm, first);
    pass.setLiveRef(tm.getTrailState());
    tick(pass, tm, first, second);
    pass.flushTexture();

    expect(uploads).toHaveLength(1);
    expect(uploads[0].yoffset).toBe(0);
    expect(uploads[0].height).toBe(MAP_H);
    expect(uploads[0].data).toBe(tm.getTrailState());

    // The next delta is partial again.
    tick(pass, tm, first, second, ship(3, 40));
    pass.flushTexture();
    expect(uploads.slice(1).map((u) => [u.yoffset, u.height])).toEqual([
      [40, 1],
    ]);
  });

  it("falls back to the min..max span for a buffer without row flags", () => {
    const { gl, uploads } = makeGl();
    const pass = makePass(gl);
    const state = new Uint16Array(MAP_W * MAP_H);
    expect(dirtyRowsOf(state)).toBeUndefined();

    pass.applyLiveDelta(state, 7, 42);
    pass.flushTexture();

    expect(uploads.map((u) => [u.yoffset, u.height])).toEqual([[7, 36]]);
  });
});

describe("RailroadPass partial upload", () => {
  function makePass(gl: unknown): RailroadPass {
    const pass = Object.create(RailroadPass.prototype) as RailroadPass;
    Object.assign(pass, {
      gl,
      mapW: MAP_W,
      mapH: MAP_H,
      railroadTex: {},
      fullUploadPending: true,
      railroadDirty: false,
      liveRailroadRef: null,
    });
    return pass;
  }

  function flush(pass: RailroadPass, state: Uint8Array): void {
    pass.uploadRailroadState(state);
    (
      pass as unknown as { flushRailroadState(s: Uint8Array): void }
    ).flushRailroadState(state);
  }

  function addRail(cache: RailroadCache, id: number, rows: number[]): void {
    // One tile per row in column 4, delivered already complete via a snap.
    const tiles = rows.map((r) => r * MAP_W + 4);
    cache.apply({
      updates: {
        [GameUpdateType.RailroadSnapEvent]: [
          {
            type: GameUpdateType.RailroadSnapEvent,
            originalId: -1,
            newId1: id,
            newId2: id + 1000,
            tiles1: tiles,
            tiles2: [],
          },
        ],
      },
    } as unknown as GameUpdateViewData);
  }

  it("sends the whole map first, then only the rows the cache changed", () => {
    const { gl, uploads } = makeGl();
    const pass = makePass(gl);
    const cache = new RailroadCache(MAP_W, MAP_H);

    addRail(cache, 1, [10, 11]);
    flush(pass, cache.railroadState);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].yoffset).toBe(0);
    expect(uploads[0].height).toBe(MAP_H);
    expect(uploads[0].data).toBe(cache.railroadState);
    expect(dirtyRowsOf(cache.railroadState)!.isClean).toBe(true);

    addRail(cache, 2, [30, 31]);
    addRail(cache, 3, [90]);
    flush(pass, cache.railroadState);

    expect(uploads.slice(1).map((u) => [u.yoffset, u.height])).toEqual([
      [30, 2],
      [90, 1],
    ]);
    for (const u of uploads.slice(1)) {
      const data = u.data as Uint8Array;
      expect(data.length).toBe(u.height * MAP_W);
      expect(data.byteOffset).toBe(u.yoffset * MAP_W);
    }
    expect(dirtyRowsOf(cache.railroadState)!.isClean).toBe(true);
  });

  it("keeps rows pending until a flush happens (e.g. while rails are faded out)", () => {
    const { gl, uploads } = makeGl();
    const pass = makePass(gl);
    const cache = new RailroadCache(MAP_W, MAP_H);
    flush(pass, cache.railroadState);
    uploads.length = 0;

    // Several ticks of changes, each flagged to the pass, but no flush.
    addRail(cache, 1, [20]);
    cache.clearDirty();
    pass.uploadRailroadState(cache.railroadState);
    addRail(cache, 2, [70]);
    cache.clearDirty();
    pass.uploadRailroadState(cache.railroadState);
    expect(uploads).toHaveLength(0);

    flush(pass, cache.railroadState);
    expect(uploads.map((u) => [u.yoffset, u.height])).toEqual([
      [20, 1],
      [70, 1],
    ]);
  });

  it("sends the whole map when the array changes, or no rows are recorded", () => {
    const { gl, uploads } = makeGl();
    const pass = makePass(gl);
    const a = new RailroadCache(MAP_W, MAP_H);
    const b = new RailroadCache(MAP_W, MAP_H);
    flush(pass, a.railroadState);
    uploads.length = 0;

    // A different array than last time: its rows say nothing about the texture.
    addRail(b, 1, [50]);
    flush(pass, b.railroadState);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].height).toBe(MAP_H);
    uploads.length = 0;

    // Flagged dirty but nothing recorded (e.g. a forced re-sync): full upload.
    flush(pass, b.railroadState);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].height).toBe(MAP_H);
    uploads.length = 0;

    // An array with no row record at all (cosmetic preview): always full.
    const plain = new Uint8Array(MAP_W * MAP_H);
    flush(pass, plain);
    flush(pass, plain);
    expect(uploads.map((u) => u.height)).toEqual([MAP_H, MAP_H]);
  });
});

describe("RailroadPass ghost preview", () => {
  function makePass(): RailroadPass {
    const pass = Object.create(RailroadPass.prototype) as RailroadPass;
    Object.assign(pass, {
      mapW: MAP_W,
      mapH: MAP_H,
      ghostTiles: new Map<number, number>(),
      ghostOps: [] as number[],
      ghostOwnerID: 0,
      ghostRailPathsRef: null,
      ghostOverlapRef: null,
    });
    return pass;
  }

  function preview(
    paths: number[][],
    overlap: number[],
    ownerID = 1,
  ): GhostPreviewData {
    return {
      ghostRailPaths: paths,
      overlappingRailroads: overlap,
      ownerID,
    } as GhostPreviewData;
  }

  function ops(pass: RailroadPass): number[] {
    return (pass as unknown as { ghostOps: number[] }).ghostOps;
  }

  it("recomputes only when the path inputs change", () => {
    const pass = makePass();
    const orient = vi.spyOn(
      pass as unknown as {
        computePathOrientations(p: number[]): unknown;
      },
      "computePathOrientations",
    );
    const paths = [[5, 6, 7]];
    const overlap = [21];

    pass.updateGhostPreview(preview(paths, overlap));
    expect(orient).toHaveBeenCalledTimes(1);
    const queued = ops(pass).slice();
    expect(queued.length).toBeGreaterThan(0);

    // Same references, new wrapper object (as the controller sends each frame).
    ops(pass).length = 0;
    pass.updateGhostPreview(preview(paths, overlap));
    pass.updateGhostPreview({ ...preview(paths, overlap) });
    expect(orient).toHaveBeenCalledTimes(1);
    expect(ops(pass)).toEqual([]);

    // A new path array is a new input.
    pass.updateGhostPreview(preview([[5, 6, 7]], overlap));
    expect(orient).toHaveBeenCalledTimes(2);
    expect(ops(pass)).toEqual([]); // same tiles → empty diff

    // So is a different owner.
    pass.updateGhostPreview(preview(paths, overlap, 2));
    expect(orient).toHaveBeenCalledTimes(3);
  });

  it("clears on null and rebuilds when the same inputs come back", () => {
    const pass = makePass();
    const paths = [[5, 6, 7]];
    const overlap: number[] = [];

    pass.updateGhostPreview(preview(paths, overlap));
    ops(pass).length = 0;

    pass.updateGhostPreview(null);
    // Every ghost tile is cleared (texel value 0).
    expect(ops(pass)).toEqual([5, 0, 6, 0, 7, 0]);
    ops(pass).length = 0;

    pass.updateGhostPreview(preview(paths, overlap));
    expect(ops(pass).filter((_, i) => i % 2 === 0)).toEqual([5, 6, 7]);
  });
});
