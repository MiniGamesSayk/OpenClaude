import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { PortExecution } from "@openfront/engine/execution/PortExecution";
import {
  WaterPathFinder,
  WaterPathMemo,
} from "@openfront/engine/pathfinding/PathFinder";
import { AirPathFinder } from "@openfront/engine/pathfinding/PathFinder.Air";
import { PathFinderStepper } from "@openfront/engine/pathfinding/PathFinderStepper";
import { PathStatus } from "@openfront/engine/pathfinding/types";
import { setup } from "./util/Setup";

// Late-game optimisations that must not change a single simulated value:
// typed-array routes (air paths, memoised water paths) and the trade-port
// draw without the expanded probability list.

describe("AirPathFinder.findPathTyped", () => {
  test("is findPath's route, tile for tile", async () => {
    const game = await setup("big_plains", {});
    const rand = new PseudoRandom(7);
    const n = game.width() * game.height();
    for (let i = 0; i < 300; i++) {
      const pf = new AirPathFinder(game);
      pf.setSeed(rand.nextInt(0, 1_000_000));
      const from = rand.nextInt(0, n);
      const to = i % 25 === 0 ? from : rand.nextInt(0, n);
      expect(Array.from(pf.findPathTyped(from, to))).toEqual(
        pf.findPath(from, to),
      );
    }
  });

  test("a stepper walks the same tiles with or without it", async () => {
    const game = await setup("big_plains", {});
    const from = game.ref(3, 4);
    const to = game.ref(80, 41);
    const walk = (shared: boolean): TileRef[] => {
      const pf = new AirPathFinder(game);
      if (!shared) {
        (pf as { findPathTyped?: unknown }).findPathTyped = undefined;
      }
      const stepper = new PathFinderStepper<TileRef>(pf);
      const out: TileRef[] = [];
      let cur = from;
      for (let i = 0; i < 500; i++) {
        // Retarget midway, like a shell chasing a moving ship.
        const dst = i < 20 ? to : game.ref(60, 60);
        const r = stepper.next(cur, dst);
        if (r.status !== PathStatus.NEXT) break;
        cur = r.node;
        out.push(cur);
      }
      return out;
    };
    expect(walk(true)).toEqual(walk(false));
  });
});

describe("WaterPathMemo.findPathTyped", () => {
  test("returns the memoised route itself, equal to findPath", async () => {
    const g = await setup("half_land_half_ocean", {}, [
      new PlayerInfo("player1", PlayerType.Human, "c1", "p1"),
    ]);
    const map = g.map();
    const all: TileRef[] = [];
    map.forEachTile((t) => all.push(t));
    const ocean = all.filter((t) => map.isOcean(t) && map.isWater(t));
    const land = all.filter((t) => map.isLand(t));
    const fresh = new WaterPathFinder(g, 0, false);
    const memo = new WaterPathMemo(fresh, map.width() * map.height(), () =>
      map.waterVersion(),
    );
    for (let i = 0; i < 20; i++) {
      const a = ocean[i % ocean.length];
      const b =
        i % 4 === 0 ? land[i % land.length] : ocean[(i * 7) % ocean.length];
      const expected = fresh.findPath(a, b);
      const shared = memo.findPathTyped(a, b);
      expect(shared === null ? null : Array.from(shared)).toEqual(expected);
      // Every caller gets its own copy, hit or miss.
      const again = memo.findPathTyped(a, b);
      if (shared !== null) expect(again).not.toBe(shared);
      expect(again).toEqual(shared);
      expect(memo.findPath(a, b)).toEqual(expected);
    }
  });
});

describe("PortExecution trade destination draw", () => {
  test("draws what randElement(tradingPorts()) would, from the same RNG", async () => {
    const game = await setup("half_land_half_ocean", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("other", PlayerType.Human, null, "other_id"),
      new PlayerInfo("third", PlayerType.Human, null, "third_id"),
    ]);
    game.config().structureMinDist = () => 1;
    const player = game.player("player_id");
    const other = game.player("other_id");
    const third = game.player("third_id");
    player.conquer(game.ref(7, 10));
    const port = player.buildUnit(UnitType.Port, game.ref(7, 10), {});
    // Several destinations with different levels, one of them allied.
    other.conquer(game.ref(0, 0));
    const p1 = other.buildUnit(UnitType.Port, game.ref(0, 0), {});
    p1.increaseLevel();
    p1.increaseLevel();
    third.conquer(game.ref(0, 5));
    third.buildUnit(UnitType.Port, game.ref(0, 5), {});
    other.conquer(game.ref(0, 8));
    other.buildUnit(UnitType.Port, game.ref(0, 8), {}).increaseLevel();

    const exec = new PortExecution(port);
    exec.init(game, 0);
    const list = exec.tradingPorts();
    expect(list.length).toBeGreaterThan(3);

    const pick = (
      exec as unknown as { pickTradingPort(): unknown }
    ).pickTradingPort.bind(exec);
    const random = (exec as unknown as { random: PseudoRandom }).random;
    for (let i = 0; i < 200; i++) {
      // Same RNG state for both: clone by seed replay.
      const seed = 1000 + i;
      (exec as unknown as { random: PseudoRandom }).random = new PseudoRandom(
        seed,
      );
      const got = pick();
      const want = new PseudoRandom(seed).randElement(list);
      expect(got).toBe(want);
    }
    (exec as unknown as { random: PseudoRandom }).random = random;
  });
});
