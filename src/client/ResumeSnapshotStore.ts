/**
 * The last multiplayer game this browser was in, as an engine snapshot, so a
 * page reload resumes it from there instead of replaying every turn since the
 * start (see ResumeGame.ts).
 *
 * One slot: saving replaces whatever was kept, so only the latest snapshot of
 * the latest game is ever stored. A snapshot is only handed back for the same
 * game, player and build; anything else found there is deleted.
 *
 * Best effort throughout: storage can be missing, full or blocked (private
 * windows, cleared site data). Every failure is logged and reads as "nothing
 * stored", which just means a full replay.
 */

export interface ResumeSnapshot {
  gameID: string;
  clientID: string;
  /** The build that wrote it: a snapshot only resumes on its own build. */
  gitCommit: string;
  /** Turns the snapshot holds: the number of the first turn it needs. */
  turns: number;
  /** When it was written (ms since epoch). */
  savedAt: number;
  /** The engine snapshot (uncompressed). */
  bytes: Uint8Array;
}

/** Where the slot lives: IndexedDB in the browser, a map in tests. */
export interface ResumeBackend {
  get(): Promise<ResumeSnapshot | undefined>;
  put(snapshot: ResumeSnapshot): Promise<void>;
  remove(): Promise<void>;
}

export class ResumeSnapshotStore {
  constructor(
    private readonly backend: () => Promise<ResumeBackend | null>,
    private readonly gitCommit: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The stored snapshot of this game, for this player and build. */
  async load(gameID: string, clientID: string): Promise<ResumeSnapshot | null> {
    try {
      const backend = await this.backend();
      if (backend === null) return null;
      const stored = await backend.get();
      if (stored === undefined) return null;
      if (
        stored.gameID === gameID &&
        stored.clientID === clientID &&
        stored.gitCommit === this.gitCommit() &&
        Number.isInteger(stored.turns) &&
        stored.turns > 0 &&
        stored.bytes instanceof Uint8Array &&
        stored.bytes.length > 0
      ) {
        return stored;
      }
      // Another game, player or build: it will never be resumed.
      await backend.remove();
      return null;
    } catch (err) {
      console.warn("resume snapshot: couldn't read", err);
      return null;
    }
  }

  /** Replaces the slot. False if it couldn't be stored. */
  async save(
    gameID: string,
    clientID: string,
    turns: number,
    bytes: Uint8Array,
  ): Promise<boolean> {
    try {
      const backend = await this.backend();
      if (backend === null) return false;
      await backend.put({
        gameID,
        clientID,
        gitCommit: this.gitCommit(),
        turns,
        savedAt: this.now(),
        bytes,
      });
      return true;
    } catch (err) {
      console.warn("resume snapshot: couldn't write", err);
      return false;
    }
  }

  /** Forgets the stored snapshot if it is of this game (any if omitted). */
  async clear(gameID?: string): Promise<void> {
    try {
      const backend = await this.backend();
      if (backend === null) return;
      if (gameID !== undefined) {
        const stored = await backend.get();
        if (stored === undefined || stored.gameID !== gameID) return;
      }
      await backend.remove();
    } catch (err) {
      console.warn("resume snapshot: couldn't delete", err);
    }
  }
}

const DB_NAME = "openfront-resume";
const DB_VERSION = 1;
const STORE = "snapshots";
const KEY = "latest";
const OPEN_TIMEOUT_MS = 3000;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** The database, or null if it didn't open in time. */
function openDatabase(
  idb: IDBFactory,
  timeoutMs: number,
): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(null);
    }, timeoutMs);
    const open = idb.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
      db.createObjectStore(STORE);
    };
    open.onsuccess = () => {
      const db = open.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      db.onversionchange = () => db.close();
      resolve(db);
    };
    open.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(open.error);
    };
  });
}

export async function openIndexedDbResumeBackend(
  idb: IDBFactory | undefined = globalThis.indexedDB,
  timeoutMs = OPEN_TIMEOUT_MS,
): Promise<ResumeBackend | null> {
  if (idb === undefined) return null;
  const db = await openDatabase(idb, timeoutMs);
  if (db === null) return null;
  return {
    async get() {
      const tx = db.transaction(STORE, "readonly");
      return (await request(tx.objectStore(STORE).get(KEY))) as
        | ResumeSnapshot
        | undefined;
    },
    async put(snapshot) {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(snapshot, KEY);
      await done(tx);
    },
    async remove() {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      await done(tx);
    },
  };
}

let shared: Promise<ResumeBackend | null> | null = null;

/** The browser's IndexedDB slot, opened on first use. */
export function browserResumeBackend(): Promise<ResumeBackend | null> {
  shared ??= openIndexedDbResumeBackend().then(
    (backend) => {
      // Timed out (another tab blocking an upgrade?): retry next time.
      if (backend === null) shared = null;
      return backend;
    },
    (err: unknown) => {
      console.warn("resume snapshot: storage unavailable", err);
      return null;
    },
  );
  return shared;
}
