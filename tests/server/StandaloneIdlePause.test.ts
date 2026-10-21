import EventEmitter from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MasterLobbyService } from "../../src/server/MasterLobbyService";
import { ServerEnv } from "../../src/server/ServerEnv";

vi.mock("../../src/server/Logger", () => ({
  logger: { child: () => ({ error: vi.fn(), info: vi.fn() }) },
}));
vi.mock("../../src/server/PollingLoop", () => ({ startPolling: vi.fn() }));

function createMockWorker() {
  const emitter = new EventEmitter() as EventEmitter & {
    send: ReturnType<typeof vi.fn>;
  };
  emitter.send = vi.fn();
  return emitter;
}

describe("ServerEnv self-hosting switches", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the official defaults when nothing is set", () => {
    expect(ServerEnv.standalone()).toBe(false);
    expect(ServerEnv.idlePauseMs()).toBe(0);
  });

  it("reads STANDALONE, IDLE_PAUSE_SEC and GAME_CREATION_RATE_MS", () => {
    vi.stubEnv("STANDALONE", "1");
    vi.stubEnv("IDLE_PAUSE_SEC", "90");
    vi.stubEnv("GAME_CREATION_RATE_MS", "120000");
    expect(ServerEnv.standalone()).toBe(true);
    expect(ServerEnv.idlePauseMs()).toBe(90_000);
    expect(ServerEnv.gameCreationRate()).toBe(120_000);
  });

  it("ignores malformed values", () => {
    vi.stubEnv("STANDALONE", "yes please");
    vi.stubEnv("IDLE_PAUSE_SEC", "soon");
    vi.stubEnv("GAME_CREATION_RATE_MS", "-5");
    expect(ServerEnv.standalone()).toBe(false);
    expect(ServerEnv.idlePauseMs()).toBe(0);
    expect(ServerEnv.gameCreationRate()).toBeGreaterThan(0);
  });
});

// With IDLE_PAUSE_SEC set, the master stops creating public lobbies once no
// browser is on a /lobbies socket and no player is in a game for that long,
// and picks scheduling up again as soon as a worker reports someone.
describe("MasterLobbyService idle pause", () => {
  let service: MasterLobbyService;
  let w0: ReturnType<typeof createMockWorker>;
  const createGameCalls = () =>
    w0.send.mock.calls.filter(([msg]) => msg?.type === "createGame").length;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("DOMAIN", "localhost");
    vi.stubEnv("PUBLIC_LOBBIES", "1");
    vi.stubEnv("IDLE_PAUSE_SEC", "60");
    vi.spyOn(ServerEnv, "numWorkers").mockReturnValue(1);
    vi.spyOn(ServerEnv, "workerIndex").mockReturnValue(0);
    vi.spyOn(ServerEnv, "generateGameId").mockReturnValue("aaaaaaaa");
    const playlist = { gameConfig: vi.fn(async () => ({})) };
    const log = { info: vi.fn(), error: vi.fn() } as any;
    service = new MasterLobbyService(playlist as any, log);
    w0 = createMockWorker();
    service.registerWorker(0, w0 as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const schedule = () => (service as any).maybeScheduleLobby() as Promise<void>;

  it("keeps scheduling while the pause delay has not elapsed", async () => {
    await schedule();
    expect(createGameCalls()).toBeGreaterThan(0);
  });

  it("stops creating lobbies after the delay with nobody around", async () => {
    w0.emit("message", { type: "lobbyList", lobbies: [], lobbyViewers: 0 });
    vi.advanceTimersByTime(61_000);
    await schedule();
    expect(createGameCalls()).toBe(0);
  });

  it("resumes as soon as a visitor or a player is reported", async () => {
    vi.advanceTimersByTime(61_000);
    await schedule();
    expect(createGameCalls()).toBe(0);

    w0.emit("message", { type: "lobbyList", lobbies: [], lobbyViewers: 1 });
    await schedule();
    expect(createGameCalls()).toBeGreaterThan(0);

    w0.send.mockClear();
    w0.emit("message", { type: "lobbyList", lobbies: [], lobbyViewers: 0 });
    vi.advanceTimersByTime(61_000);
    await schedule();
    expect(createGameCalls()).toBe(0);

    w0.emit("message", { type: "lobbyList", lobbies: [], activeClients: 2 });
    await schedule();
    expect(createGameCalls()).toBeGreaterThan(0);
  });

  it("never pauses without IDLE_PAUSE_SEC", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("DOMAIN", "localhost");
    vi.stubEnv("PUBLIC_LOBBIES", "1");
    vi.advanceTimersByTime(24 * 3600 * 1000);
    await schedule();
    expect(createGameCalls()).toBeGreaterThan(0);
  });

  it("creates no public lobby unless PUBLIC_LOBBIES is set", async () => {
    vi.stubEnv("PUBLIC_LOBBIES", "");
    await schedule();
    expect(createGameCalls()).toBe(0);
  });
});
