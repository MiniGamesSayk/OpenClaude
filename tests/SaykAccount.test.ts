import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSaykAccountService,
  saykResults,
} from "../src/server/SaykAccount";

const TOKEN = "a".repeat(64);
const stats = {};

describe("saykResults", () => {
  const players = [
    { clientID: "AAAAAAAA", userId: "u1" },
    { clientID: "BBBBBBBB", userId: "u2" },
  ];

  it("compte une victoire pour chaque joueur d'une équipe gagnante confirmée", () => {
    const r = saykResults(
      players,
      {
        winner: ["team", "Red", "AAAAAAAA", "CCCCCCCC"],
        allPlayersStats: stats,
      },
      true,
      90_400,
    );
    expect(r).toEqual([
      { userId: "u1", add: { games: 1, wins: 1, secondsPlayed: 90 }, max: {} },
      { userId: "u2", add: { games: 1, wins: 0, secondsPlayed: 90 }, max: {} },
    ]);
  });

  it("lit un vainqueur seul (« player »)", () => {
    const r = saykResults(
      players,
      { winner: ["player", "BBBBBBBB"], allPlayersStats: stats },
      true,
      1000,
    );
    expect(r.map((x) => x.add.wins)).toEqual([0, 1]);
  });

  it("n'accorde aucune victoire si le résultat n'est pas confirmé", () => {
    const r = saykResults(
      players,
      { winner: ["player", "AAAAAAAA"], allPlayersStats: stats },
      false,
      1000,
    );
    expect(r.map((x) => x.add.wins)).toEqual([0, 0]);
    expect(r.map((x) => x.add.games)).toEqual([1, 1]);
  });

  it("sans vainqueur, compte seulement la partie", () => {
    const r = saykResults(players, null, true, Number.NaN);
    expect(r[0]!.add).toEqual({ games: 1, wins: 0, secondsPlayed: 0 });
  });
});

describe("createSaykAccountService", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("est inactif sans configuration", () => {
    expect(createSaykAccountService(null)).toBeNull();
    expect(createSaykAccountService({ url: "", key: "k" })).toBeNull();
  });

  it("ignore un cookie mal formé sans appeler le service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const svc = createSaykAccountService({
      url: "http://auth:3000",
      key: "k",
    })!;
    expect(await svc.resolve(undefined)).toBeNull();
    expect(await svc.resolve("sayk_session=nope")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("interroge le service avec la clé du jeu", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ game: "openclaude", user: { id: "42" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const svc = createSaykAccountService({
      url: "http://auth:3000/",
      key: "k",
    })!;
    expect(await svc.resolve(`x=1; sayk_session=${TOKEN}`)).toBe("42");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://auth:3000/internal/resolve");
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
  });

  it("reste anonyme si le service est injoignable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const svc = createSaykAccountService({
      url: "http://auth:3000",
      key: "k",
    })!;
    expect(await svc.resolve(`sayk_session=${TOKEN}`)).toBeNull();
  });

  it("envoie les statistiques sans jamais lever d'erreur", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", fetchMock);
    const svc = createSaykAccountService({
      url: "http://auth:3000",
      key: "k",
    })!;
    svc.report("42", { games: 1 }, {});
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock.mock.calls[0]![0]).toBe("http://auth:3000/internal/stats");
  });
});
