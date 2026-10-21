/**
 * The snapshot a reload resumes from: one slot, handed back only for the
 * same game, player and build; kept fresh while the game runs; never an
 * error when storage or the snapshot is bad (the game just replays).
 */

import type { GameStartInfo } from "@openfront/engine-api/Schemas";
import { describe, expect, it, vi } from "vitest";
import {
  ResumeSnapshotSaver,
  startGameWorker,
} from "../../src/client/ResumeGame";
import {
  openIndexedDbResumeBackend,
  ResumeSnapshotStore,
  type ResumeBackend,
  type ResumeSnapshot,
} from "../../src/client/ResumeSnapshotStore";
import type { WorkerClient } from "../../src/client/WorkerClient";

function memoryBackend() {
  const slot: { value: ResumeSnapshot | undefined } = { value: undefined };
  const backend: ResumeBackend = {
    get: async () => slot.value,
    put: async (s) => {
      slot.value = s;
    },
    remove: async () => {
      slot.value = undefined;
    },
  };
  return { backend, slot };
}

function storeOn(backend: ResumeBackend | null, commit = "abc123") {
  return new ResumeSnapshotStore(
    async () => backend,
    () => commit,
    () => 1000,
  );
}

const bytes = (n: number) => new Uint8Array(n).fill(7);

describe("ResumeSnapshotStore", () => {
  it("hands back the snapshot of the same game, player and build", async () => {
    const { backend } = memoryBackend();
    const store = storeOn(backend);
    expect(await store.save("GAME1", "CLIENT1", 300, bytes(10))).toBe(true);
    const got = await store.load("GAME1", "CLIENT1");
    expect(got).toEqual({
      gameID: "GAME1",
      clientID: "CLIENT1",
      gitCommit: "abc123",
      turns: 300,
      savedAt: 1000,
      bytes: bytes(10),
    });
  });

  it("keeps only the latest snapshot", async () => {
    const { backend, slot } = memoryBackend();
    const store = storeOn(backend);
    await store.save("GAME1", "CLIENT1", 300, bytes(10));
    await store.save("GAME2", "CLIENT1", 50, bytes(5));
    expect(slot.value?.gameID).toBe("GAME2");
    expect(await store.load("GAME2", "CLIENT1")).not.toBeNull();
  });

  it.each([
    ["another game", "GAME2", "CLIENT1", "abc123"],
    ["another player", "GAME1", "CLIENT2", "abc123"],
    ["another build", "GAME1", "CLIENT1", "def456"],
  ])(
    "deletes a snapshot of %s instead of handing it back",
    async (_, gameID, clientID, commit) => {
      const { backend, slot } = memoryBackend();
      await storeOn(backend).save("GAME1", "CLIENT1", 300, bytes(10));
      expect(await storeOn(backend, commit).load(gameID, clientID)).toBeNull();
      expect(slot.value).toBeUndefined();
    },
  );

  it("treats a malformed record as nothing stored", async () => {
    const { backend, slot } = memoryBackend();
    slot.value = {
      gameID: "GAME1",
      clientID: "CLIENT1",
      gitCommit: "abc123",
      turns: Number.NaN,
      savedAt: 0,
      bytes: "not bytes" as unknown as Uint8Array,
    };
    expect(await storeOn(backend).load("GAME1", "CLIENT1")).toBeNull();
    expect(slot.value).toBeUndefined();
  });

  it("clears only the given game's snapshot", async () => {
    const { backend, slot } = memoryBackend();
    const store = storeOn(backend);
    await store.save("GAME1", "CLIENT1", 300, bytes(10));
    await store.clear("GAME2");
    expect(slot.value).toBeDefined();
    await store.clear("GAME1");
    expect(slot.value).toBeUndefined();
  });

  it("never throws when storage fails or is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: ResumeBackend = {
      get: () => Promise.reject(new Error("QuotaExceededError")),
      put: () => Promise.reject(new Error("QuotaExceededError")),
      remove: () => Promise.reject(new Error("blocked")),
    };
    for (const store of [
      storeOn(failing),
      storeOn(null),
      new ResumeSnapshotStore(
        () => Promise.reject(new Error("no idb")),
        () => "abc123",
      ),
    ]) {
      expect(await store.save("GAME1", "CLIENT1", 1, bytes(1))).toBe(false);
      expect(await store.load("GAME1", "CLIENT1")).toBeNull();
      await expect(store.clear("GAME1")).resolves.toBeUndefined();
    }
    expect(await openIndexedDbResumeBackend(undefined)).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("ResumeSnapshotSaver", () => {
  function setup(opts: { takeMs?: number } = {}) {
    const { backend, slot } = memoryBackend();
    const store = storeOn(backend);
    let now = 0;
    let workerTick = 0;
    const take = vi.fn(async () => {
      now += opts.takeMs ?? 5;
      return { snapshot: bytes(4), tick: workerTick };
    });
    const saver = new ResumeSnapshotSaver(take, store, "GAME1", "CLIENT1", 0, {
      intervalTicks: 100,
      ticksPerSnapshotMs: 2,
      maxIntervalTicks: 400,
      now: () => now,
    });
    const tick = async (t: number, catchingUp = false) => {
      workerTick = t;
      saver.onTick(t, catchingUp);
      await flush();
    };
    const setWorkerTick = (t: number) => (workerTick = t);
    return { saver, take, slot, tick, store, setWorkerTick };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("saves every interval of game time, with the snapshot's turn count", async () => {
    const { take, slot, tick } = setup();
    for (let t = 1; t <= 250; t++) await tick(t);
    expect(take).toHaveBeenCalledTimes(2);
    expect(slot.value?.turns).toBe(200);
  });

  it("doesn't save while catching up", async () => {
    const { take, tick } = setup();
    for (let t = 1; t <= 300; t++) await tick(t, true);
    expect(take).not.toHaveBeenCalled();
    await tick(301);
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("saves less often when snapshots are slow", async () => {
    const slow = setup({ takeMs: 80 });
    for (let t = 1; t <= 1000; t++) await slow.tick(t);
    // At 100, then 160 ticks apart (80 ms x 2): 260, 420, 580, 740, 900.
    expect(slow.take).toHaveBeenCalledTimes(6);
    const slower = setup({ takeMs: 500 });
    for (let t = 1; t <= 1000; t++) await slower.tick(t);
    // At 100, then capped at 400 apart: 500, 900.
    expect(slower.take).toHaveBeenCalledTimes(3);
  });

  it("saves what's new when the page is hidden", async () => {
    const { saver, take, slot, setWorkerTick } = setup();
    saver.onHidden(0);
    await flush();
    expect(take).not.toHaveBeenCalled();
    // The worker may be a few ticks past what the page has applied.
    setWorkerTick(44);
    saver.onHidden(42);
    await flush();
    expect(take).toHaveBeenCalledTimes(1);
    expect(slot.value?.turns).toBe(44);
  });

  it("forgets the game when stopped for good, even with a save in flight", async () => {
    const { saver, slot, tick } = setup();
    await tick(100);
    expect(slot.value?.turns).toBe(100);
    const inFlight = saver.saveNow();
    saver.stop(true);
    await inFlight;
    await flush();
    expect(slot.value).toBeUndefined();
    await tick(500);
    expect(slot.value).toBeUndefined();
  });
});

describe("startGameWorker", () => {
  const start = { gameID: "GAME1" } as GameStartInfo;

  function fakeWorkers(failRestore: boolean) {
    const made: { snapshot?: Uint8Array; startTurn?: number }[] = [];
    const make = (
      _start: GameStartInfo,
      _clientID: string | undefined,
      snapshot?: Uint8Array,
      startTurn?: number,
    ) => {
      made.push({ snapshot, startTurn });
      return {
        startTurn: startTurn ?? 0,
        initialize: async () => {
          if (snapshot !== undefined && failRestore) {
            throw new Error("snapshot map differs");
          }
        },
      } as unknown as WorkerClient;
    };
    return { made, make };
  }

  it("resumes from the stored snapshot at its turn", async () => {
    const { backend } = memoryBackend();
    const store = storeOn(backend);
    await store.save("GAME1", "CLIENT1", 300, bytes(10));
    const { made, make } = fakeWorkers(false);
    const worker = await startGameWorker(start, "CLIENT1", true, store, make);
    expect(worker.startTurn).toBe(300);
    expect(made).toEqual([{ snapshot: bytes(10), startTurn: 300 }]);
  });

  it("replays from turn 0 when the restore fails, and drops the snapshot", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend, slot } = memoryBackend();
    const store = storeOn(backend);
    await store.save("GAME1", "CLIENT1", 300, bytes(10));
    const { made, make } = fakeWorkers(true);
    const worker = await startGameWorker(start, "CLIENT1", true, store, make);
    expect(worker.startTurn).toBe(0);
    expect(made[1]).toEqual({ snapshot: undefined, startTurn: undefined });
    expect(slot.value).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("doesn't look for a snapshot for a game that can't resume", async () => {
    const { backend } = memoryBackend();
    const store = storeOn(backend);
    await store.save("GAME1", "CLIENT1", 300, bytes(10));
    const { make } = fakeWorkers(false);
    const local = await startGameWorker(start, "CLIENT1", false, store, make);
    expect(local.startTurn).toBe(0);
    const noClient = await startGameWorker(start, undefined, true, store, make);
    expect(noClient.startTurn).toBe(0);
  });
});
