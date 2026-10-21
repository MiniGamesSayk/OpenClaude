/**
 * Resuming a multiplayer game after a page reload: the client restores the
 * worker from a stored snapshot and asks the server only for the turns after
 * it (see src/client/ResumeGame.ts). Checked here against a game played
 * straight through:
 *
 *  - turn numbering: the snapshot taken after N turns resumes on turn N, and
 *    every later tick reports the same hash the server compares;
 *  - the view: a GameView fed only the resumed runner's updates (the first
 *    carries the full state, GameRunner.resyncView) ends up showing what a
 *    GameView fed every tick from turn 0 shows;
 *  - catch-up batching: a GameView that presents only some ticks
 *    (GameView.update's `present`) ends up the same too.
 */

import {
  ErrorUpdate,
  GameUpdateType,
  GameUpdateViewData,
  HashUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { GameStartInfo, Turn } from "@openfront/engine-api/Schemas";
import { loadTerrainMap } from "@openfront/engine-lib/game/TerrainMapLoader";
import { Game } from "@openfront/engine/game/Game";
import {
  createGameRunner,
  createGameRunnerFromSnapshot,
} from "@openfront/engine/GameRunner";
import { readSnapshotHeader } from "@openfront/engine/snapshot/GameSnapshot";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import type { WirePlayer } from "@openfront/shared/WireSchemas";
import { describe, expect, it } from "vitest";
import { GameView } from "../../src/client/view/GameView";
import {
  scriptedGameStart,
  scriptedTurn,
  TestDataMapLoader,
} from "../util/ScriptedGame";
import { stubConfig, stubWorker } from "../util/viewStubs";

const MAP = "world";
// Past the spawn phase, with structures, ships and rails about.
const RESUME_AT = 1000;
const TOTAL = 1160;
const TIMEOUT = 300_000;

function files(start: GameStartInfo) {
  return loadMapFiles(
    new TestDataMapLoader(MAP),
    start.config.gameMap,
    start.config.gameMapSize,
  );
}

async function newView(start: GameStartInfo): Promise<GameView> {
  return new GameView(
    stubWorker(),
    stubConfig(),
    await loadTerrainMap(await files(start)),
    undefined, // spectator
    "spectator",
    null,
    start.gameID,
    start.players as unknown as WirePlayer[],
  );
}

function collect(into: GameUpdateViewData[]) {
  return (gu: GameUpdateViewData | ErrorUpdate) => {
    if ("errMsg" in gu) throw new Error(`${gu.errMsg}\n${gu.stack}`);
    into.push(gu);
  };
}

function hashesOf(updates: GameUpdateViewData[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const gu of updates) {
    for (const h of gu.updates[GameUpdateType.Hash] as HashUpdate[]) {
      out.set(h.tick, h.hash);
    }
  }
  return out;
}

function gameHash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}

/** Feeds a copy (views keep and mutate update objects). */
function feed(view: GameView, gu: GameUpdateViewData, present = true): void {
  view.update(structuredClone(gu), present);
}

function expectSameBuffer(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  what: string,
): void {
  expect(b.length, what).toBe(a.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      throw new Error(`${what}: index ${i} is ${b[i]}, expected ${a[i]}`);
    }
  }
}

/** What the renderer and HUD read, minus unit motion (checked apart). */
function shown(view: GameView) {
  const fd = view.frameData();
  const terrain = new Uint8Array(view.width() * view.height());
  for (let t = 0; t < terrain.length; t++) terrain[t] = view.terrainByte(t);
  const units = [...fd.units.values()]
    .filter((u) => u.isActive)
    .map((u) => {
      // Positions are compared with the engine below; lastOwnerID is
      // history a resumed view can't have.
      const { pos, lastPos, lastOwnerID, ...rest } = u;
      void pos;
      void lastPos;
      void lastOwnerID;
      return rest;
    })
    .sort((a, b) => a.id - b.id);
  return {
    tick: fd.tick,
    inSpawnPhase: view.inSpawnPhase(),
    frameInSpawnPhase: fd.inSpawnPhase,
    tileState: fd.tileState,
    terrain,
    railroadState: fd.railroadState,
    units,
    players: [...fd.players.values()].sort((a, b) => a.smallID - b.smallID),
    // Dead players' names aren't drawn; a live view froze them where the
    // player died, a resumed one never saw them alive.
    names: [...fd.names.values()]
      .filter((n) => view.player(n.playerID).isAlive())
      .sort((a, b) => a.playerID.localeCompare(b.playerID)),
    playerIDs: view
      .players()
      .map((p) => p.id())
      .sort(),
  };
}

function expectShowsTheSame(expected: GameView, actual: GameView): void {
  const a = shown(expected);
  const b = shown(actual);
  expectSameBuffer(a.tileState, b.tileState, "tile state");
  expectSameBuffer(a.terrain, b.terrain, "terrain");
  // Where railroads cross, the glyph is that of whichever was drawn in
  // last, which differs for railroads a resumed view draws in together.
  expectSameBuffer(
    a.railroadState.map((v) => (v > 0 ? 1 : 0)),
    b.railroadState.map((v) => (v > 0 ? 1 : 0)),
    "railroad tiles",
  );
  expect(b.tick).toBe(a.tick);
  expect(b.inSpawnPhase).toBe(a.inSpawnPhase);
  expect(b.frameInSpawnPhase).toBe(a.frameInSpawnPhase);
  expect(b.playerIDs).toEqual(a.playerIDs);
  expect(b.players).toEqual(a.players);
  expect(b.names).toEqual(a.names);
  expect(b.units).toEqual(a.units);
}

describe("resuming a game from a stored snapshot", () => {
  it(
    "replays only the turns after the snapshot and shows the same game",
    { timeout: TIMEOUT },
    async () => {
      const start = scriptedGameStart();

      // The server's turns, played straight through (a client from turn 0).
      const fullUpdates: GameUpdateViewData[] = [];
      const full = await createGameRunner(
        start,
        undefined,
        await files(start),
        collect(fullUpdates),
      );
      const turns: Turn[] = [];
      let snapshot: Uint8Array | null = null;
      while (turns.length < TOTAL) {
        // What the client stores: a snapshot between ticks...
        if (turns.length === RESUME_AT) {
          snapshot = full.snapshot("test");
          // Worth checking: ships or nukes on a path, and railroads.
          const game = full.game as unknown as {
            planDrivenUnitIds: Set<number>;
          };
          expect(game.planDrivenUnitIds.size).toBeGreaterThan(0);
          expect(
            full.game.units().filter((u) => u.hasTrainStation()).length,
          ).toBeGreaterThan(1);
        }
        const turn = scriptedTurn(full.game);
        expect(turn.turnNumber).toBe(turns.length);
        turns.push(turn);
        full.addTurn(turn);
        expect(full.executeNextTick()).toBe(true);
      }
      expect(full.game.inSpawnPhase()).toBe(false);

      // ...whose tick is the number of turns it holds: the client resumes
      // with turnsSeen = tick, so rejoin asks for turns.slice(tick).
      const header = readSnapshotHeader(snapshot!);
      expect(header.tick).toBe(RESUME_AT);
      expect(header.gameID).toBe(start.gameID);

      const resumedUpdates: GameUpdateViewData[] = [];
      const resumed = await createGameRunnerFromSnapshot(
        start,
        snapshot!,
        undefined,
        await files(start),
        collect(resumedUpdates),
      );
      resumed.resyncView(); // what the worker does for a restored game
      for (const turn of turns.slice(header.tick)) resumed.addTurn(turn);
      while (resumed.pendingTurns() > 0) {
        expect(resumed.executeNextTick(resumed.pendingTurns())).toBe(true);
      }

      // Same simulation: the hashes the server compares, and the end state.
      expect(resumed.game.ticks()).toBe(full.game.ticks());
      expect(gameHash(resumed.game)).toBe(gameHash(full.game));
      const fullHashes = hashesOf(fullUpdates);
      const resumedHashes = hashesOf(resumedUpdates);
      expect(resumedHashes.size).toBe((TOTAL - RESUME_AT) / 10);
      for (const [tick, hash] of resumedHashes) {
        expect(hash, `hash at tick ${tick}`).toBe(fullHashes.get(tick));
      }
      expect(resumedUpdates[0].tick).toBe(RESUME_AT + 1);
      expect(resumedUpdates[0].viewResync).toEqual({
        startTick: full.game.inSpawnPhase()
          ? null
          : (full.game as unknown as { startTick: number }).startTick,
      });
      expect(resumedUpdates.slice(1).some((gu) => gu.viewResync)).toBe(false);

      // The views.
      const fullView = await newView(start);
      for (const gu of fullUpdates) feed(fullView, gu);
      const resumedView = await newView(start);
      for (const gu of resumedUpdates) feed(resumedView, gu);
      expect(resumedView.units().length).toBeGreaterThan(0);
      expect(fullView.frameData().railroadState.some((v) => v > 0)).toBe(true);
      expectShowsTheSame(fullView, resumedView);

      // A resumed view gets no motion plans for paths that started before
      // the snapshot, so those units report every move instead: wherever no
      // plan drives a unit, it is where the engine has it.
      const planned = new Set(resumedView.motionPlannedUnitIds());
      let checked = 0;
      for (const unit of resumed.game.units()) {
        if (!unit.isActive() || planned.has(unit.id())) continue;
        expect(resumedView.unit(unit.id())?.tile(), `unit ${unit.id()}`).toBe(
          unit.tile(),
        );
        checked++;
      }
      expect(checked).toBeGreaterThan(0);

      // Catch-up batching: presenting one tick in nine (and the last) ends
      // on the same picture as presenting all of them.
      const batchedView = await newView(start);
      fullUpdates.forEach((gu, i) =>
        feed(batchedView, gu, i % 9 === 0 || i === fullUpdates.length - 1),
      );
      expectShowsTheSame(fullView, batchedView);
    },
  );
});
