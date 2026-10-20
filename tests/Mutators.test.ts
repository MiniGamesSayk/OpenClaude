import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdate,
  GameUpdateType,
  KingOfTheHillUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { MUTATOR_DEFAULTS } from "@openfront/engine-lib/configuration/Config";
import {
  findHillCenter,
  hillRadius,
  hillTiles,
  KingOfTheHillExecution,
} from "@openfront/engine/execution/KingOfTheHillExecution";
import {
  MeteorShowerExecution,
  meteorsPerVolley,
} from "@openfront/engine/execution/MeteorShowerExecution";
import { UnderdogExecution } from "@openfront/engine/execution/UnderdogExecution";
import { WinCheckExecution } from "@openfront/engine/execution/WinCheckExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { vi } from "vitest";
import { setup } from "./util/Setup";

const human = (name: string) =>
  new PlayerInfo(name, PlayerType.Human, `${name}_client`, `${name}_id`);

function conquerAll(game: Game, player: Player): void {
  game.forEachTile((tile) => {
    if (game.isLand(tile)) player.conquer(tile);
  });
}

// Every update the game emits while `fn` runs, whether from a tick or from
// an execution driven directly.
function captureUpdates(game: Game, fn: () => void): GameUpdate[] {
  const updates: GameUpdate[] = [];
  const spy = vi.spyOn(game, "addUpdate").mockImplementation((u) => {
    updates.push(u);
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return updates;
}

describe("Mutators config", () => {
  test("every mutator is off unless enabled", async () => {
    const game = await setup("plains");
    expect(game.config().mutators()).toEqual({
      meteorShower: false,
      blitz: false,
      kingOfTheHill: false,
      underdog: false,
    });
    const on = await setup("plains", {
      mutators: { meteorShower: true, underdog: true },
    });
    expect(on.config().mutators()).toEqual({
      meteorShower: true,
      blitz: false,
      kingOfTheHill: false,
      underdog: true,
    });
  });
});

describe("Blitz mutator", () => {
  test("halves build and reload times", async () => {
    const normal = (await setup("plains")).config();
    const blitz = (
      await setup("plains", { mutators: { blitz: true } })
    ).config();
    expect(blitz.SAMCooldown()).toBe(Math.floor(normal.SAMCooldown() / 2));
    expect(blitz.SiloCooldown()).toBe(Math.floor(normal.SiloCooldown() / 2));
    for (const type of [UnitType.City, UnitType.MissileSilo, UnitType.Port]) {
      expect(blitz.unitInfo(type).constructionDuration).toBe(
        Math.floor(normal.unitInfo(type).constructionDuration! / 2),
      );
    }
  });

  test("doubles troop and gold income", async () => {
    const normal = await setup("big_plains", {}, [human("a")]);
    const blitz = await setup("big_plains", { mutators: { blitz: true } }, [
      human("a"),
    ]);
    const rates = [normal, blitz].map((game) => {
      const p = game.player("a_id");
      for (let x = 0; x < 20; x++) p.conquer(game.ref(x, 0));
      p.addTroops(5_000);
      return {
        troops: game.config().troopIncreaseRate(p),
        gold: game.config().goldAdditionRate(p),
      };
    });
    expect(rates[1].troops).toBeCloseTo(rates[0].troops * 2, 6);
    expect(rates[1].gold).toBe(rates[0].gold * 2n);
  });
});

describe("Meteor Shower mutator", () => {
  test("volley size grows with the map, up to the cap", () => {
    expect(meteorsPerVolley(40_000)).toBe(1);
    expect(meteorsPerVolley(MUTATOR_DEFAULTS.meteorLandTilesPerMeteor)).toBe(2);
    expect(meteorsPerVolley(100_000_000)).toBe(
      MUTATOR_DEFAULTS.meteorMaxPerVolley,
    );
  });

  async function firstImpact(seed: number) {
    const game = await setup("big_plains", { infiniteGold: true }, [
      human("a"),
    ]);
    const a = game.player("a_id");
    conquerAll(game, a);
    a.addTroops(500_000);
    // A city every 10 tiles: any crater swallows at least one.
    for (let x = 5; x < 200; x += 10) {
      for (let y = 5; y < 200; y += 10) {
        a.buildUnit(UnitType.City, game.ref(x, y), {});
      }
    }
    game.addExecution(new MeteorShowerExecution(seed));
    const tilesBefore = a.numTilesOwned();
    const troopsBefore = a.troops();
    const citiesBefore = a.units(UnitType.City).length;
    let impact: TileRef | null = null;
    const deadline = (MUTATOR_DEFAULTS.meteorGraceSeconds + 5) * 10;
    for (let i = 0; i < deadline && impact === null; i++) {
      const updates = game.executeNextTick();
      impact = updates[GameUpdateType.MeteorImpact][0]?.tile ?? null;
    }
    return {
      game,
      a,
      impact,
      tilesBefore,
      troopsBefore,
      citiesBefore,
    };
  }

  test("a meteor blasts a crater after the grace period", async () => {
    const r = await firstImpact(7);
    expect(r.impact).not.toBeNull();
    const { game, a } = r;
    expect(a.numTilesOwned()).toBeLessThan(r.tilesBefore);
    expect(game.numTilesWithFallout()).toBeGreaterThan(0);
    expect(game.hasFallout(r.impact!)).toBe(true);
    expect(a.troops()).toBeLessThan(r.troopsBefore);
    expect(a.units(UnitType.City).length).toBeLessThan(r.citiesBefore);
    const outer = MUTATOR_DEFAULTS.meteorOuterRadius;
    for (const city of a.units(UnitType.City)) {
      expect(game.euclideanDistSquared(city.tile(), r.impact!)).toBeGreaterThan(
        outer * outer,
      );
    }
  });

  test("impacts are deterministic for a seed", async () => {
    const first = await firstImpact(1234);
    const second = await firstImpact(1234);
    expect(first.impact).not.toBeNull();
    expect(second.impact).toBe(first.impact);
  });

  test("nothing falls before the grace period ends", async () => {
    const game = await setup("big_plains", {}, [human("a")]);
    conquerAll(game, game.player("a_id"));
    game.addExecution(new MeteorShowerExecution(7));
    for (let i = 0; i < MUTATOR_DEFAULTS.meteorGraceSeconds * 10 - 5; i++) {
      const updates = game.executeNextTick();
      expect(updates[GameUpdateType.MeteorImpact]).toHaveLength(0);
    }
    expect(game.numTilesWithFallout()).toBe(0);
  });
});

describe("King of the Hill mutator", () => {
  test("hill size and placement", async () => {
    expect(hillRadius(40_000)).toBe(MUTATOR_DEFAULTS.hillMinRadius);
    expect(hillRadius(100_000_000)).toBe(MUTATOR_DEFAULTS.hillMaxRadius);
    const game = await setup("big_plains");
    expect(findHillCenter(game)).toBe(game.ref(100, 100));
    const water = await setup("half_land_half_ocean");
    const center = findHillCenter(water);
    expect(water.isLand(center)).toBe(true);
    for (const tile of hillTiles(water, center, 8)) {
      expect(water.isLand(tile)).toBe(true);
    }
  });

  async function hillGame() {
    const game = await setup("big_plains", {}, [human("a"), human("b")]);
    const exec = new KingOfTheHillExecution();
    exec.init(game, 0);
    const center = findHillCenter(game);
    const tiles = hillTiles(game, center, hillRadius(game.numLandTiles()));
    return { game, exec, tiles };
  }

  const lastHillUpdate = (updates: GameUpdate[]) =>
    updates.filter((u) => u.type === GameUpdateType.KingOfTheHill).pop() as
      | KingOfTheHillUpdate
      | undefined;

  test("the hill stays closed until it opens", async () => {
    const { game, exec, tiles } = await hillGame();
    const a = game.player("a_id");
    for (const t of tiles) a.conquer(t);
    vi.spyOn(game, "elapsedGameSeconds").mockReturnValue(30);
    const update = lastHillUpdate(captureUpdates(game, () => exec.tick(10)));
    expect(update?.opensInSeconds).toBe(MUTATOR_DEFAULTS.hillOpenSeconds - 30);
    expect(update?.holder).toBeNull();
    expect(update?.leaders).toEqual([]);
  });

  test("holding the hill long enough wins the game", async () => {
    const { game, exec, tiles } = await hillGame();
    const a = game.player("a_id");
    const b = game.player("b_id");
    // a holds 3/4 of the hill, b the rest.
    tiles.forEach((t, i) => (i % 4 === 0 ? b : a).conquer(t));
    vi.spyOn(game, "elapsedGameSeconds").mockReturnValue(10_000);
    const first = lastHillUpdate(captureUpdates(game, () => exec.tick(10)));
    expect(first?.opensInSeconds).toBe(0);
    expect(first?.holder).toBe(a.id());
    expect(first?.leaders).toEqual([{ side: a.id(), seconds: 1 }]);
    for (let s = 2; s < MUTATOR_DEFAULTS.hillHoldSecondsToWin; s++) {
      exec.tick(s * 10);
    }
    expect(game.getWinner()).toBeNull();
    exec.tick(MUTATOR_DEFAULTS.hillHoldSecondsToWin * 10);
    expect(game.getWinner()).toBe(a);
    expect(exec.isActive()).toBe(false);
  });

  test("half of the hill is not enough to control it", async () => {
    const { game, exec, tiles } = await hillGame();
    const a = game.player("a_id");
    // Exactly half (rounded down) for a; the rest is unowned.
    tiles.slice(0, Math.floor(tiles.length / 2)).forEach((t) => a.conquer(t));
    vi.spyOn(game, "elapsedGameSeconds").mockReturnValue(10_000);
    const update = lastHillUpdate(captureUpdates(game, () => exec.tick(10)));
    expect(update?.holder).toBeNull();
  });

  test("tribes block the hill but never control it", async () => {
    const { game, exec, tiles } = await hillGame();
    const bot = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe_id"),
    );
    for (const t of tiles) bot.conquer(t);
    vi.spyOn(game, "elapsedGameSeconds").mockReturnValue(10_000);
    const update = lastHillUpdate(captureUpdates(game, () => exec.tick(10)));
    expect(update?.holder).toBeNull();
  });

  test("the win check stands down once another rule picked a winner", async () => {
    const { game } = await hillGame();
    const winCheck = new WinCheckExecution();
    winCheck.init(game, 0);
    game.setWinner(game.player("a_id"), game.stats().stats());
    winCheck.tick(10);
    expect(winCheck.isActive()).toBe(false);
  });
});

describe("Underdog mutator", () => {
  test("small sides earn bonus troops and gold, the leader doesn't", async () => {
    const game = await setup("big_plains", {}, [human("big"), human("small")]);
    const big = game.player("big_id");
    const small = game.player("small_id");
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe_id"),
    );
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) big.conquer(game.ref(x, y));
    }
    for (let x = 0; x < 50; x++) small.conquer(game.ref(x, 150));
    for (let x = 0; x < 50; x++) tribe.conquer(game.ref(x, 180));
    for (const p of [big, small, tribe]) p.addTroops(10_000);

    const expectedTroops = Math.floor(
      (game.config().troopIncreaseRate(small) *
        10 *
        MUTATOR_DEFAULTS.underdogBonusPercent) /
        100,
    );
    const before = [big, small, tribe].map((p) => ({
      troops: p.troops(),
      gold: p.gold(),
    }));
    const exec = new UnderdogExecution();
    exec.init(game, 0);
    const updates = captureUpdates(game, () => exec.tick(10));

    expect(big.troops()).toBe(before[0].troops);
    expect(big.gold()).toBe(before[0].gold);
    expect(small.troops()).toBe(before[1].troops + expectedTroops);
    expect(small.gold()).toBeGreaterThan(before[1].gold);
    expect(tribe.troops()).toBe(before[2].troops);
    // Told once, when the bonus starts.
    const messages = (u: GameUpdate[]) =>
      u.filter(
        (x) =>
          x.type === GameUpdateType.DisplayEvent &&
          x.message === "events_display.underdog_bonus",
      );
    expect(messages(updates)).toHaveLength(1);
    expect(messages(captureUpdates(game, () => exec.tick(20)))).toHaveLength(0);
  });
});
