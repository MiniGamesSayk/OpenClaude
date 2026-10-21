/**
 * Getting back into a running multiplayer game after a page reload without
 * replaying it from turn 0.
 *
 * While a game runs, ResumeSnapshotSaver keeps an engine snapshot of it in
 * the browser (ResumeSnapshotStore). When the page joins that game again,
 * startGameWorker restores the worker from the snapshot, and the client asks
 * the server only for the turns after it (WorkerClient.startTurn). The
 * restored engine's first update carries the full current state for the
 * fresh GameView (GameRunner.resyncView). If anything about the snapshot is
 * off, the game is replayed from the start as before.
 */

import { ClientID, GameStartInfo } from "@openfront/engine-api/Schemas";
import { ClientEnv } from "./ClientEnv";
import {
  browserResumeBackend,
  ResumeSnapshotStore,
} from "./ResumeSnapshotStore";
import { WorkerClient } from "./WorkerClient";

export const resumeSnapshotStore = new ResumeSnapshotStore(
  browserResumeBackend,
  () => ClientEnv.gitCommit(),
);

type MakeWorker = (
  start: GameStartInfo,
  clientID: ClientID | undefined,
  snapshot?: Uint8Array,
  startTurn?: number,
) => WorkerClient;

const makeWorkerClient: MakeWorker = (start, clientID, snapshot, startTurn) =>
  new WorkerClient(start, clientID, snapshot, startTurn);

/**
 * An initialized worker for the game: resumed from the stored snapshot when
 * `resumable` and one of this game is stored, else started from turn 0.
 */
export async function startGameWorker(
  start: GameStartInfo,
  clientID: ClientID | undefined,
  resumable: boolean,
  store: ResumeSnapshotStore = resumeSnapshotStore,
  makeWorker: MakeWorker = makeWorkerClient,
): Promise<WorkerClient> {
  if (resumable && clientID !== undefined) {
    const saved = await store.load(start.gameID, clientID);
    if (saved !== null) {
      const startedAt = performance.now();
      const worker = makeWorker(start, clientID, saved.bytes, saved.turns);
      try {
        await worker.initialize();
        console.log(
          `resumed game ${start.gameID} at turn ${saved.turns} from a ` +
            `${Math.round(saved.bytes.length / 1024)} KB snapshot in ` +
            `${Math.round(performance.now() - startedAt)} ms`,
        );
        return worker;
      } catch (err) {
        // A failed init stops its worker (WorkerClient.initialize).
        console.warn("couldn't resume from the snapshot, replaying", err);
        await store.clear(start.gameID);
      }
    }
  }
  const worker = makeWorker(start, clientID);
  await worker.initialize();
  return worker;
}

export interface SaverOptions {
  /** Least game ticks between saves (10 ticks = 1 s). */
  intervalTicks?: number;
  /**
   * Game ticks between saves per ms the last snapshot took. The worker runs
   * no tick while it snapshots, so 1 (a 1% share of its time at 10 ticks/s)
   * spaces 200 ms snapshots 20 s apart.
   */
  ticksPerSnapshotMs?: number;
  /** Most game ticks between saves. */
  maxIntervalTicks?: number;
  now?: () => number;
}

/**
 * Keeps the stored snapshot of the running game fresh: every so much game
 * time while the client is caught up, and when the page is hidden.
 * Snapshotting runs in the worker, which runs no tick meanwhile: a few
 * hundred ms on a big late game. The slower it is, the rarer the saves
 * (SaverOptions.ticksPerSnapshotMs).
 */
export class ResumeSnapshotSaver {
  private savedTurns: number;
  private intervalTicks: number;
  private readonly minIntervalTicks: number;
  private readonly ticksPerSnapshotMs: number;
  private readonly maxIntervalTicks: number;
  private readonly now: () => number;
  private pending: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly take: () => Promise<{
      snapshot: Uint8Array;
      tick: number;
    }>,
    private readonly store: Pick<ResumeSnapshotStore, "save" | "clear">,
    private readonly gameID: string,
    private readonly clientID: ClientID,
    /** Turns the game already started from (a resume's snapshot). */
    startTurn: number,
    options: SaverOptions = {},
  ) {
    this.savedTurns = startTurn;
    this.minIntervalTicks = options.intervalTicks ?? 250;
    this.intervalTicks = this.minIntervalTicks;
    this.ticksPerSnapshotMs = options.ticksPerSnapshotMs ?? 1;
    this.maxIntervalTicks = options.maxIntervalTicks ?? 1500;
    this.now = options.now ?? (() => performance.now());
  }

  /** After each tick the client applied. */
  onTick(tick: number, catchingUp: boolean): void {
    if (catchingUp || tick - this.savedTurns < this.intervalTicks) return;
    void this.saveNow();
  }

  /** The page is going away or into the background: save what's new. */
  onHidden(tick: number): void {
    if (tick > this.savedTurns) void this.saveNow();
  }

  /** Takes and stores a snapshot unless one is already on its way. */
  saveNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.pending ??= this.save().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async save(): Promise<void> {
    try {
      const startedAt = this.now();
      const { snapshot, tick } = await this.take();
      const ms = this.now() - startedAt;
      this.intervalTicks = Math.min(
        Math.max(
          Math.ceil(ms * this.ticksPerSnapshotMs),
          this.minIntervalTicks,
        ),
        this.maxIntervalTicks,
      );
      if (this.stopped || tick <= this.savedTurns) return;
      // Not retried on failure before the next interval either.
      this.savedTurns = tick;
      await this.store.save(this.gameID, this.clientID, tick, snapshot);
      console.debug(
        `resume snapshot: turn ${tick}, ${Math.round(snapshot.length / 1024)} KB, ${Math.round(ms)} ms`,
      );
    } catch (err) {
      console.warn("resume snapshot: couldn't take one", err);
    }
  }

  /** Saves no more. `forget`: also delete this game's stored snapshot. */
  stop(forget: boolean): void {
    if (this.stopped) return;
    this.stopped = true;
    if (!forget) return;
    // After a save that is already on its way, or it would bring it back.
    void (this.pending ?? Promise.resolve()).then(() =>
      this.store.clear(this.gameID),
    );
  }
}
