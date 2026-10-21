// @vitest-environment jsdom
/**
 * Late-game load harness: engine tick cost and client main-thread cost with
 * hundreds of ships, dozens of missiles in flight and standing auto-fire
 * orders — the situation players report as "it lags like crazy at the end of
 * the game".
 *
 * A real map runs with nations + bots (infinite gold, instant build) for a
 * warm-up phase, then the stress phase drives the biggest players into the
 * late-game unit mix every tick, deterministically (seeded PRNG, game state
 * only):
 *   - ports, silos, SAMs, airbases, factories (trade ships and trains follow)
 *   - a warship fleet per player
 *   - a standing AutoFire order per player, cycling every silo bomb type
 *   - transport ships and paratroopers at enemy territory
 *
 * Per stress tick it measures:
 *   sim      GameRunner.executeNextTick (worker side), by execution class
 *   view     GameView.update (main thread)
 *   builder  WebGLFrameBuilder.update → uploadFrameData → MapRenderer/
 *            GPURenderer.update*() with every GL call stubbed (CPU only)
 *   frames   six GPURenderer frames (60 fps / 10 Hz tick) with stubbed GL
 *
 * and prints the final sim hash + unit census so optimizations can be
 * checked against the same scenario.
 *
 * Opt-in (it takes a minute or more):
 *   LATEGAME_PERF=1 npx vitest tests/perf/client/LateGamePerf.test.ts --run
 * Knobs: LATEGAME_MAP (default "World"), LATEGAME_WARMUP (ticks, 600),
 *   LATEGAME_TICKS (stress ticks, 600), LATEGAME_PLAYERS (stressed players,
 *   40), LATEGAME_PROFILE=1 (V8 CPU profile + top functions).
 */
import "./Shims";

import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  SiloBombs,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  GameUpdateViewData,
  HashUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { GameConfig, GameStartInfo } from "@openfront/engine-api/Schemas";
import { Config } from "@openfront/engine-lib/configuration/Config";
import { loadTerrainMap } from "@openfront/engine-lib/game/TerrainMapLoader";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { AutoFireExecution } from "@openfront/engine/execution/AutoFireExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { ParatrooperExecution } from "@openfront/engine/execution/ParatrooperExecution";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { createGame } from "@openfront/engine/game/GameImpl";
import { createNationsForGame } from "@openfront/engine/game/NationCreation";
import { GameRunner } from "@openfront/engine/GameRunner";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
import fs from "fs";
import path from "path";
import { describe, it } from "vitest";
import { MapRenderer } from "../../../src/client/render/gl/MapRenderer";
import { preloadAtlasData } from "../../../src/client/render/gl/passes/name-pass/AtlasData";
import { createRenderSettings } from "../../../src/client/render/gl/RenderSettings";
import { ALL_UNIT_TYPES } from "../../../src/client/render/types";
import { GameView } from "../../../src/client/view/GameView";
import { WebGLFrameBuilder } from "../../../src/client/WebGLFrameBuilder";
import type { WorkerClient } from "../../../src/client/WorkerClient";
import { NodeGameMapLoader } from "../fullgame/NodeGameMapLoader";
import {
  CpuProfiler,
  ExecutionProfiler,
  summarizeCpuProfile,
  TickStats,
} from "../fullgame/Profiler";

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const FRAME_BUDGET_MS = 16.7;
const FRAMES_PER_TICK = 6;
/**
 * Process CPU time in ms. Stages are timed in CPU time rather than wall time
 * so results stay comparable on a loaded machine (other processes stealing
 * cores inflate wall time, not our CPU time).
 */
const cpuNow = (): number => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

const env = (k: string, d: string) => process.env[k] ?? d;
/** Progress line straight to stderr (vitest buffers console output). */
const progress = (msg: string) => process.stderr.write(`[lategame] ${msg}\n`);

// ── Stub WebGL2: every call is a no-op, constants are distinct numbers ──

function createProxyGL(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const consts = new Map<string, number>();
  let next = 0x1000;
  const constant = (name: string) => {
    let v = consts.get(name);
    if (v === undefined) {
      v = next++;
      consts.set(name, v);
    }
    return v;
  };
  const constProxy = new Proxy(
    {},
    { get: (_, p) => (typeof p === "string" ? constant(p) : undefined) },
  );
  const fns = new Map<string, unknown>();
  const noop = () => undefined;
  const obj = () => ({});
  const special: Record<string, unknown> = {
    canvas,
    drawingBufferWidth: 1280,
    drawingBufferHeight: 720,
    getParameter: (p: number) =>
      p === constant("UNMASKED_RENDERER_WEBGL") ? "Stub GPU" : 16384,
    getExtension: () => constProxy,
    getSupportedExtensions: () => [],
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getAttribLocation: () => 0,
    getUniformLocation: obj,
    getUniformBlockIndex: () => 0,
    checkFramebufferStatus: () => constant("FRAMEBUFFER_COMPLETE"),
    getError: () => 0,
    isContextLost: () => false,
    fenceSync: obj,
    clientWaitSync: () => constant("ALREADY_SIGNALED"),
    getSyncParameter: () => constant("SIGNALED"),
  };
  return new Proxy({} as WebGL2RenderingContext, {
    get(_, p) {
      if (typeof p !== "string") return undefined;
      if (p in special) return special[p];
      if (/^[A-Z0-9_]+$/.test(p)) return constant(p);
      let f = fns.get(p);
      if (f === undefined) {
        f = p.startsWith("create") ? obj : noop;
        fns.set(p, f);
      }
      return f;
    },
  });
}

function installBrowserStubs(): void {
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Atlases never load under jsdom; decode() must not reject.
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => new Promise(() => {}),
  });
  // The name pass needs the MSDF atlas metrics; serve them from disk.
  g.fetch = (url: string) =>
    String(url).endsWith("msdf-atlas.json")
      ? Promise.resolve({
          ok: true,
          json: async () =>
            JSON.parse(
              fs.readFileSync(
                path.join(PROJECT_ROOT, "resources/atlases/msdf-atlas.json"),
                "utf8",
              ),
            ),
        })
      : new Promise(() => {});
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return createProxyGL(this);
  } as unknown as HTMLCanvasElement["getContext"];
}

// ── Stress driver ──

const STRUCTURE_GOALS: [UnitType, number][] = [
  [UnitType.Port, 3],
  [UnitType.MissileSilo, 3],
  [UnitType.SAMLauncher, 2],
  [UnitType.Factory, 2],
  [UnitType.City, 2],
  [UnitType.Airbase, 1],
];
const WARSHIPS_PER_PLAYER = 8;
const BOMBS = [...SiloBombs.types];

class StressDriver {
  private rand: PseudoRandom;
  private tileCache = new Map<Player, TileRef[]>();

  constructor(
    private game: Game,
    private players: Player[],
    seed: number,
  ) {
    this.rand = new PseudoRandom(seed);
  }

  private ownedTiles(p: Player): TileRef[] {
    let tiles = this.tileCache.get(p);
    if (tiles === undefined) {
      tiles = [...p.tiles()];
      this.tileCache.set(p, tiles);
    }
    return tiles;
  }

  private randomTile(p: Player, shore: boolean): TileRef | null {
    const tiles = shore
      ? [...p.borderTiles()].filter((t) => this.game.isOceanShore(t))
      : this.ownedTiles(p);
    if (tiles.length === 0) return null;
    return tiles[this.rand.nextInt(0, tiles.length)];
  }

  private enemyOf(p: Player): Player | null {
    for (let i = 0; i < 6; i++) {
      const e = this.players[this.rand.nextInt(0, this.players.length)];
      if (e !== p && e.isAlive() && !p.isFriendly(e)) return e;
    }
    return null;
  }

  tick(tick: number): void {
    this.tileCache.clear();
    const g = this.game;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p.isAlive()) continue;
      // Infinite gold only covers humans: keep the stressed players rich.
      if (p.gold() < 100_000_000n) p.addGold(1_000_000_000n);
      // Stagger the work over ticks so not every player acts on the same one.
      const phase = (tick + i) % 20;

      if (phase === 0) {
        for (const [type, goal] of STRUCTURE_GOALS) {
          if (p.units(type).length >= goal) continue;
          const t = this.randomTile(p, type === UnitType.Port);
          if (t === null || p.canBuild(type, t) === false) continue;
          g.addExecution(new ConstructionExecution(p, type, t));
        }
      }
      const ports = p.units(UnitType.Port);
      if (
        phase === 5 &&
        ports.length > 0 &&
        p.units(UnitType.Warship).length < WARSHIPS_PER_PLAYER
      ) {
        const port = ports[this.rand.nextInt(0, ports.length)];
        const t = g.neighbors(port.tile()).find((n) => g.isWater(n));
        if (t !== undefined && p.canBuild(UnitType.Warship, t) !== false) {
          g.addExecution(new ConstructionExecution(p, UnitType.Warship, t));
        }
      }
      if (phase === 10) {
        const e = this.enemyOf(p);
        const t = e && this.randomTile(e, true);
        if (t !== null && t !== undefined) {
          g.addExecution(
            new TransportShipExecution(p, t, Math.floor(p.troops() / 20)),
          );
        }
      }
      if (phase === 15 && tick % 40 < 20) {
        const e = this.enemyOf(p);
        const t = e && this.randomTile(e, false);
        if (t !== null && t !== undefined) {
          g.addExecution(new ParatrooperExecution(p, t));
        }
      }
      if (tick % 50 === i % 50) {
        // Fresh standing fire order (replaces the previous one).
        const e = this.enemyOf(p);
        const t = e && this.randomTile(e, false);
        if (t !== null && t !== undefined) {
          const bomb = BOMBS[(tick + i) % BOMBS.length];
          g.addExecution(new AutoFireExecution(p, bomb, t));
        }
      }
    }
  }
}

// ── Client side: real GameView + WebGLFrameBuilder + MapRenderer (stub GL) ──

interface Client {
  gameView: GameView;
  /** Applies one tick; returns CPU ms for [view, builder, frames]. */
  apply(gu: GameUpdateViewData): [number, number, number];
}

function createClient(
  config: Config,
  mapData: Awaited<ReturnType<typeof loadTerrainMap>>,
  gameID: string,
): Client {
  const gameView = new GameView(
    {} as unknown as WorkerClient,
    config,
    mapData,
    undefined,
    "perf",
    null,
    gameID,
    [],
  );
  const gm = mapData.gameMap;
  let frameCb: FrameRequestCallback | null = null;
  const view = new MapRenderer(
    document.createElement("canvas"),
    {
      mapWidth: gm.width(),
      mapHeight: gm.height(),
      unitTypes: [...ALL_UNIT_TYPES],
      players: [],
      maxPlayers: 1024,
    },
    () => new Uint8Array(gm.width() * gm.height()),
    new Float32Array(4096 * 2 * 4),
    config,
    createRenderSettings(),
    (cb) => {
      frameCb = cb;
      return 0;
    },
    () => {
      frameCb = null;
    },
  );
  view.setCameraState(gm.width() / 2, gm.height() / 2, 1);
  const builder = new WebGLFrameBuilder(view);
  let frameClock = 0;
  return {
    gameView,
    apply(gu) {
      let t0 = cpuNow();
      gameView.update(gu);
      const viewMs = cpuNow() - t0;
      t0 = cpuNow();
      builder.update(gameView);
      const builderMs = cpuNow() - t0;
      t0 = cpuNow();
      for (let f = 0; f < FRAMES_PER_TICK; f++) {
        const cb = frameCb;
        frameCb = null;
        frameClock += 1000 / 60;
        cb?.(frameClock);
      }
      return [viewMs, builderMs, cpuNow() - t0];
    },
  };
}

// ── View-state digest (checks client optimizations change nothing) ──

class Fnv32 {
  private h = 0x811c9dc5;
  byte(b: number): void {
    this.h = Math.imul(this.h ^ (b & 0xff), 0x01000193) >>> 0;
  }
  u32(n: number): void {
    this.byte(n);
    this.byte(n >>> 8);
    this.byte(n >>> 16);
    this.byte(n >>> 24);
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) this.u32(s.charCodeAt(i));
  }
  digest(): string {
    return this.h.toString(16).padStart(8, "0");
  }
}

const bigintSafe = (_k: string, v: unknown) =>
  typeof v === "bigint" ? `${v}n` : v;

/** Mixes the renderer-facing view state into `fnv`. */
function mixViewState(fnv: Fnv32, gameView: GameView): void {
  const frame = gameView.frameData();
  for (const st of gameView.unitStates().values()) {
    fnv.str(JSON.stringify(st, bigintSafe));
  }
  const trail = frame.trailState;
  for (let i = 0; i < trail.length; i += 7) fnv.byte(trail[i]);
  fnv.str(JSON.stringify(frame.nukeTelegraphs));
  fnv.str(JSON.stringify(frame.attackRings));
  fnv.str(JSON.stringify([...frame.playerStatus]));
  fnv.str(JSON.stringify(frame.events, bigintSafe));
  for (const u of gameView.units()) {
    fnv.u32(u.id());
    fnv.u32(u.lastTile());
    fnv.u32(u.wasUpdated() ? 1 : 0);
  }
}

// ── Report helpers ──

function fmtMs(ms: number): string {
  return ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2);
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => r[c].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, c) => cell.padEnd(widths[c])).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w)))]
    .concat(rows.map(line))
    .join("\n");
}

function resolveMap(name: string): GameMapType {
  const key = Object.keys(GameMapType).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  if (key === undefined) throw new Error(`unknown map ${name}`);
  return GameMapType[key as keyof typeof GameMapType];
}

// ── Main ──

async function run(): Promise<void> {
  installBrowserStubs();
  await preloadAtlasData();
  console.debug = () => {};
  const warn = console.warn;
  console.warn = () => {};

  const map = resolveMap(env("LATEGAME_MAP", "World"));
  const warmupTicks = parseInt(env("LATEGAME_WARMUP", "600"), 10);
  const stressTicks = parseInt(env("LATEGAME_TICKS", "600"), 10);
  const stressedPlayers = parseInt(env("LATEGAME_PLAYERS", "40"), 10);
  const profileCpu = env("LATEGAME_PROFILE", "0") === "1";
  // LATEGAME_CLIENT=0 runs the engine alone. Engine and client share modules
  // here (in the browser they live in different isolates), so the client's
  // UnitView makes shared engine-lib call sites polymorphic; engine-only
  // runs give the worker's true numbers.
  const runClient = env("LATEGAME_CLIENT", "1") === "1";
  const seed = "late-game";

  const gameConfig: GameConfig = {
    gameMap: map,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Public,
    difficulty: Difficulty.Hard,
    nations: "default",
    donateGold: false,
    donateTroops: false,
    bots: 200,
    infiniteGold: true,
    infiniteTroops: false,
    instantBuild: true,
    randomSpawn: false,
  };
  const gameStart: GameStartInfo = {
    gameID: seed,
    lobbyCreatedAt: 0,
    config: gameConfig,
    players: [],
  };
  const mapLoader = new NodeGameMapLoader(
    path.join(PROJECT_ROOT, "resources/maps"),
  );

  // Worker side (mirrors FullGamePerf so executions are profiled from init).
  const config = new EngineConfig(gameConfig, false);
  const terrain = await loadTerrainMap(
    await loadMapFiles(mapLoader, gameConfig.gameMap, gameConfig.gameMapSize),
  );
  const random = new PseudoRandom(simpleHash(gameStart.gameID));
  const nations = createNationsForGame(
    gameStart,
    terrain.nations,
    terrain.additionalNations,
    0,
    random,
  );
  const game = createGame(
    [],
    nations,
    terrain.gameMap,
    terrain.miniGameMap,
    config,
    terrain.teamGameSpawnAreas,
  );
  // Attached before init so the nations' executions are timed too; the
  // stress-phase share is the difference against a mark taken at its start.
  const execProfiler = new ExecutionProfiler();
  execProfiler.attach(game);
  let currentGu: GameUpdateViewData | null = null;
  let lastHash: HashUpdate | undefined;
  let fatal: string | undefined;
  const runner = new GameRunner(
    game,
    new Executor(game, gameStart.gameID, undefined),
    (gu) => {
      if ("errMsg" in gu) {
        fatal = `${gu.errMsg}\n${gu.stack ?? ""}`;
        return;
      }
      currentGu = gu;
    },
  );
  runner.init();

  // Client side: own config + map copy, real GameView, real MapRenderer.
  const clientConfig = new Config(gameConfig, false);
  const clientMap = await loadTerrainMap(
    await loadMapFiles(mapLoader, gameConfig.gameMap, gameConfig.gameMapSize),
  );
  const loadClientMap = async () =>
    loadTerrainMap(
      await loadMapFiles(mapLoader, gameConfig.gameMap, gameConfig.gameMapSize),
    );
  // LATEGAME_CLIENT_REPS=N: record the update stream, then replay it into N
  // fresh clients and keep the best run — the client stages measured on a
  // fixed input, which repeats far better than one live pass on a busy box.
  const clientReps = parseInt(env("LATEGAME_CLIENT_REPS", "0"), 10);
  const recorded: GameUpdateViewData[] = [];
  const liveClient =
    runClient && clientReps === 0
      ? createClient(clientConfig, clientMap, gameStart.gameID)
      : null;

  let turn = 0;
  let stressStats: Record<string, TickStats> | null = null;
  const step = (): void => {
    runner.addTurn({ turnNumber: turn++, intents: [] });
    currentGu = null;
    const t0 = cpuNow();
    const ok = runner.executeNextTick();
    const simMs = cpuNow() - t0;
    if (!ok || fatal !== undefined || currentGu === null) {
      throw new Error(`game errored at tick ${game.ticks()}: ${fatal}`);
    }
    const gu: GameUpdateViewData = currentGu;
    const hashes = gu.updates[GameUpdateType.Hash] as HashUpdate[];
    if (hashes.length > 0) lastHash = hashes[hashes.length - 1];
    if (runClient && clientReps > 0) recorded.push(structuredClone(gu));
    if (liveClient === null) {
      stressStats?.sim.record(gu.tick, simMs);
      return;
    }
    const [viewMs, builderMs, framesMs] = liveClient.apply(structuredClone(gu));
    if (stressStats !== null) {
      const tick = gu.tick;
      stressStats.sim.record(tick, simMs);
      stressStats.view.record(tick, viewMs);
      stressStats.builder.record(tick, builderMs);
      stressStats.frames.record(tick, framesMs);
      stressStats.mainTotal.record(tick, viewMs + builderMs);
    }
  };

  progress("spawn phase");
  while (game.inSpawnPhase()) {
    const t = performance.now();
    step();
    if (game.ticks() % 100 === 0) {
      progress(`spawn tick ${game.ticks()} ${fmtMs(performance.now() - t)}ms`);
    }
  }
  progress(`spawn done at tick ${game.ticks()}`);
  const tStart = performance.now();
  for (let i = 0; i < warmupTicks; i++) {
    step();
    if (i % 100 === 0) progress(`warm-up ${i}, ${game.units().length} units`);
  }
  console.log(
    `warm-up: ${warmupTicks} ticks in ${fmtMs(performance.now() - tStart)}ms, ` +
      `${game.units().length} units`,
  );

  const players = game
    .players()
    .filter((p) => p.isAlive())
    .sort((a, b) => b.numTilesOwned() - a.numTilesOwned())
    .slice(0, stressedPlayers);
  const driver = new StressDriver(game, players, simpleHash(seed));
  // Ramp the late-game state up before measuring.
  for (let i = 0; i < 200; i++) {
    driver.tick(game.ticks());
    step();
  }

  const execMark = new Map(execProfiler.report().map((r) => [r.name, r]));
  stressStats = {
    sim: new TickStats(),
    view: new TickStats(),
    builder: new TickStats(),
    frames: new TickStats(),
    mainTotal: new TickStats(),
  };
  const stressStartIdx = recorded.length;
  const cpu = profileCpu && clientReps === 0 ? new CpuProfiler() : null;
  await cpu?.start();
  const census = new Map<string, number>();
  const viewFnv = new Fnv32();
  let viewDigest = "";
  for (let i = 0; i < stressTicks; i++) {
    driver.tick(game.ticks());
    step();
    if (i % 100 === 0) progress(`stress ${i}, ${game.units().length} units`);
    if (liveClient !== null && i % 25 === 0) {
      mixViewState(viewFnv, liveClient.gameView);
    }
    if (i % 50 === 0) {
      for (const u of game.units()) {
        census.set(u.type(), (census.get(u.type()) ?? 0) + 1);
      }
    }
  }
  const profile = cpu ? await cpu.stop() : null;
  let replayProfile: Awaited<ReturnType<CpuProfiler["stop"]>> | null = null;
  for (let r = 0; r < clientReps; r++) {
    const client = createClient(
      clientConfig,
      await loadClientMap(),
      gameStart.gameID,
    );
    const st = {
      view: new TickStats(),
      builder: new TickStats(),
      frames: new TickStats(),
      mainTotal: new TickStats(),
    };
    const fnv = new Fnv32();
    const repCpu =
      profileCpu && r === clientReps - 1 ? new CpuProfiler() : null;
    for (let i = 0; i < recorded.length; i++) {
      if (i === stressStartIdx) await repCpu?.start();
      const gu = structuredClone(recorded[i]);
      const [v, b, f] = client.apply(gu);
      if (i < stressStartIdx) continue;
      st.view.record(gu.tick, v);
      st.builder.record(gu.tick, b);
      st.frames.record(gu.tick, f);
      st.mainTotal.record(gu.tick, v + b);
      if ((i - stressStartIdx) % 25 === 0) mixViewState(fnv, client.gameView);
    }
    if (repCpu) replayProfile = await repCpu.stop();
    const total = st.mainTotal.summarize(FRAME_BUDGET_MS).totalMs;
    progress(`client replay ${r + 1}/${clientReps}: ${fmtMs(total)}ms`);
    const best = stressStats as Record<string, TickStats>;
    if (r === 0 || total < best.mainTotal.summarize(FRAME_BUDGET_MS).totalMs) {
      Object.assign(best, st);
    }
    if (r === 0) viewDigest = fnv.digest();
    else if (fnv.digest() !== viewDigest)
      viewDigest += ` (rep ${r + 1}: ${fnv.digest()}!)`;
  }
  console.warn = warn;
  if (liveClient !== null) viewDigest = viewFnv.digest();

  const samples = Math.ceil(stressTicks / 50);
  const s = stressStats as Record<string, TickStats>;
  const out: string[] = [];
  out.push(
    `\n=== Late-game perf: ${map}, ${stressTicks} stress ticks, ${players.length} stressed players ===`,
  );
  out.push(
    `Final hash: ${lastHash ? `${lastHash.hash} (tick ${lastHash.tick})` : "n/a"}` +
      (runClient ? `, view digest: ${viewDigest}` : ""),
  );
  out.push(
    `Units (mean over stress phase): ` +
      [...census.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}=${Math.round(n / samples)}`)
        .join(", "),
  );
  const rows: [string, TickStats][] = [
    ["sim tick (worker)", s.sim],
    ["GameView.update", s.view],
    ["WebGLFrameBuilder.update", s.builder],
    ["view+builder (main/tick)", s.mainTotal],
    [`${FRAMES_PER_TICK} frames (main)`, s.frames],
  ];
  out.push(
    table(
      ["stage", "mean", "p50", "p95", "p99", "max", "total"],
      rows.map(([name, st]) => {
        const r = st.summarize(FRAME_BUDGET_MS);
        return [
          name,
          fmtMs(r.meanMs),
          fmtMs(r.p50Ms),
          fmtMs(r.p95Ms),
          fmtMs(r.p99Ms),
          fmtMs(r.maxMs),
          fmtMs(r.totalMs),
        ];
      }),
    ),
  );
  out.push(`\n--- Engine time by execution class (stress phase) ---`);
  out.push(
    table(
      ["execution", "total ms", "tick ms", "init ms", "new instances"],
      execProfiler
        .report()
        .map((r) => {
          const m = execMark.get(r.name);
          return {
            name: r.name,
            totalMs: r.totalMs - (m?.totalMs ?? 0),
            tickMs: r.tickMs - (m?.tickMs ?? 0),
            initMs: r.initMs - (m?.initMs ?? 0),
            instances: r.instances - (m?.instances ?? 0),
          };
        })
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, 20)
        .map((r) => [
          r.name,
          fmtMs(r.totalMs),
          fmtMs(r.tickMs),
          fmtMs(r.initMs),
          String(r.instances),
        ]),
    ),
  );
  const shownProfile = profile ?? replayProfile;
  if (shownProfile) {
    const fns = summarizeCpuProfile(shownProfile, PROJECT_ROOT);
    out.push(`\n--- Top functions by self time ---`);
    out.push(
      table(
        ["self ms", "%", "function", "location"],
        fns
          .slice(0, 45)
          .map((f) => [
            fmtMs(f.selfMs),
            f.selfPct.toFixed(1),
            f.functionName,
            f.location,
          ]),
      ),
    );
    const dir = path.join(PROJECT_ROOT, "tests/perf/output");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "lategame.cpuprofile"),
      JSON.stringify(shownProfile),
    );
  }
  process.stderr.write(out.join("\n") + "\n");
}

describe.skipIf(process.env.LATEGAME_PERF !== "1")("late-game perf", () => {
  it("measures engine + client cost under late-game unit load", async () => {
    await run();
  }, 3_600_000);
});
