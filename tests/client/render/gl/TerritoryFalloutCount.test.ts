/**
 * TerritoryPass counts the tiles carrying the fallout bit in the tile state
 * the GPU holds, so the renderer can skip the fallout bloom/light passes (which
 * draw nothing without fallout) while the count is zero.
 *
 * The count has to survive every way tile state reaches the GPU: full
 * replacement (first tick, seek), per-frame drip drains and the spawn-phase
 * flush-all.
 */

import { describe, expect, it, vi } from "vitest";
import { TerritoryPass } from "../../../../src/client/render/gl/passes/TerritoryPass";
import {
  FALLOUT_BIT,
  OWNER_MASK,
} from "../../../../src/client/render/gl/utils/TileCodec";

const W = 8;
const H = 8;
const BUCKETS = 4;

function makePass(): TerritoryPass {
  const pass = Object.create(TerritoryPass.prototype) as TerritoryPass;
  Object.assign(pass, {
    mapW: W,
    mapH: H,
    cpuTileState: new Uint16Array(W * H),
    nBuckets: BUCKETS,
    dripBuckets: Array.from({ length: BUCKETS }, () => [] as number[]),
    currentBucket: 0,
    falloutCount: 0,
    falloutTouched: false,
    fullUploadPending: false,
    tilesDirty: false,
    borderPatchConsumer: null,
    scatter: { push: vi.fn(), clear: vi.fn() },
  });
  return pass;
}

/** Run every drip bucket through the per-frame drain. */
function drainAll(pass: TerritoryPass): void {
  for (let i = 0; i < BUCKETS; i++) pass.drainDripBucket();
}

function stateWith(entries: Record<number, number>): Uint16Array {
  const state = new Uint16Array(W * H);
  for (const [ref, value] of Object.entries(entries))
    state[Number(ref)] = value;
  return state;
}

describe("TerritoryPass.hasFallout", () => {
  it("is false for a fresh pass and for a state without fallout", () => {
    const pass = makePass();
    expect(pass.hasFallout()).toBe(false);
    pass.setLiveRef(stateWith({ 3: 5, 9: 7 }));
    expect(pass.hasFallout()).toBe(false);
  });

  it("counts fallout already present in a full state replacement", () => {
    const pass = makePass();
    pass.setLiveRef(stateWith({ 3: FALLOUT_BIT, 4: FALLOUT_BIT | 2, 5: 2 }));
    expect(pass.hasFallout()).toBe(true);

    // A later replacement (seek) recounts from scratch rather than adding.
    pass.setLiveRef(stateWith({}));
    expect(pass.hasFallout()).toBe(false);
  });

  it("follows fallout bits set and cleared by drip drains", () => {
    const pass = makePass();
    const live = stateWith({});
    pass.setLiveRef(live);

    live[10] = FALLOUT_BIT;
    live[11] = FALLOUT_BIT | 3;
    pass.applyLiveDelta(live, [10, 11]);
    drainAll(pass);
    expect(pass.hasFallout()).toBe(true);

    // Clearing one of two leaves one.
    live[10] = 0;
    pass.applyLiveDelta(live, [10]);
    drainAll(pass);
    expect(pass.hasFallout()).toBe(true);

    live[11] = 3;
    pass.applyLiveDelta(live, [11]);
    drainAll(pass);
    expect(pass.hasFallout()).toBe(false);
  });

  it("ignores owner changes that leave the fallout bit alone", () => {
    const pass = makePass();
    const live = stateWith({ 6: FALLOUT_BIT | 1 });
    pass.setLiveRef(live);
    expect(pass.hasFallout()).toBe(true);

    // Owner flips on a fallout tile, and on a clean one.
    live[6] = FALLOUT_BIT | 2;
    live[7] = 9;
    pass.applyLiveDelta(live, [6, 7]);
    drainAll(pass);
    expect(pass.hasFallout()).toBe(true);

    live[6] = 2 & OWNER_MASK; // the single fallout tile is cleared
    pass.applyLiveDelta(live, [6]);
    drainAll(pass);
    expect(pass.hasFallout()).toBe(false);
  });

  it("counts the same tile only once across repeated updates", () => {
    const pass = makePass();
    const live = stateWith({});
    pass.setLiveRef(live);

    // Set, clear and set again in arrival order within one drain.
    for (const value of [FALLOUT_BIT, 0, FALLOUT_BIT]) {
      live[12] = value;
      pass.applyLiveDelta(live, [12]);
    }
    drainAll(pass);
    expect(pass.hasFallout()).toBe(true);

    live[12] = 0;
    pass.applyLiveDelta(live, [12]);
    drainAll(pass);
    expect(pass.hasFallout()).toBe(false);
  });

  it("follows the spawn-phase flush-all path too", () => {
    const pass = makePass();
    const live = stateWith({});
    pass.setLiveRef(live);

    live[20] = FALLOUT_BIT;
    live[21] = FALLOUT_BIT;
    pass.applyLiveDelta(live, [20, 21]);
    pass.flushAllDripBuckets();
    expect(pass.hasFallout()).toBe(true);

    live[20] = 0;
    live[21] = 0;
    pass.applyLiveDelta(live, [20, 21]);
    pass.flushAllDripBuckets();
    expect(pass.hasFallout()).toBe(false);
  });
});
