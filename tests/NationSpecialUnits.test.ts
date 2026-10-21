import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { NationSpecialUnitsBehavior } from "@openfront/engine/execution/nation/NationSpecialUnitsBehavior";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

let game: Game;
let nation: Player;
let enemy: Player;

function conquerSquare(p: Player, cx: number, cy: number, r: number) {
  for (let x = cx - r; x <= cx + r; x++) {
    for (let y = cy - r; y <= cy + r; y++) {
      if (game.isValidCoord(x, y)) p.conquer(game.ref(x, y));
    }
  }
}

async function makeGame(difficulty: Difficulty, cities = 4): Promise<void> {
  game = await setup(
    "big_plains",
    { infiniteGold: false, instantBuild: true, difficulty },
    [
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy"),
    ],
  );
  nation = game.player("nation");
  enemy = game.player("enemy");
  conquerSquare(nation, 40, 40, 30);
  conquerSquare(enemy, 140, 40, 20);
  for (let i = 0; i < cities; i++) {
    nation.buildUnit(UnitType.City, game.ref(20 + i * 16, 20), {});
  }
  nation.addGold(500_000_000n);
}

/** Lets the behavior act on enough different ticks to use every branch. */
function actFor(behavior: NationSpecialUnitsBehavior, rounds: number) {
  for (let i = 0; i < rounds; i++) {
    behavior.act(game.ticks());
    executeTicks(game, 2);
  }
}

describe("Nations and the newer units", () => {
  test("an established nation with spare gold builds hospitals and banks", async () => {
    await makeGame(Difficulty.Hard, 6);
    actFor(new NationSpecialUnitsBehavior(game, nation), 10);
    expect(nation.units(UnitType.Hospital).length).toBeGreaterThan(0);
    expect(nation.units(UnitType.Bank).length).toBeGreaterThan(0);
    expect(nation.units(UnitType.Airbase).length).toBeGreaterThan(0);
  });

  test("bunkers only once an enemy has missile silos", async () => {
    await makeGame(Difficulty.Hard, 8);
    const behavior = new NationSpecialUnitsBehavior(game, nation);
    actFor(behavior, 10);
    expect(nation.units(UnitType.Bunker)).toHaveLength(0);

    enemy.buildUnit(UnitType.MissileSilo, game.ref(140, 40), {});
    actFor(behavior, 10);
    expect(nation.units(UnitType.Bunker).length).toBeGreaterThan(0);
  });

  test("small or easy nations leave them alone", async () => {
    await makeGame(Difficulty.Hard, 2);
    actFor(new NationSpecialUnitsBehavior(game, nation), 10);
    expect(nation.units(UnitType.Hospital)).toHaveLength(0);

    await makeGame(Difficulty.Easy, 8);
    actFor(new NationSpecialUnitsBehavior(game, nation), 10);
    expect(nation.units(UnitType.Hospital)).toHaveLength(0);
    expect(nation.units(UnitType.Bank)).toHaveLength(0);
  });

  test("a nation at war strikes the enemy with special warheads", async () => {
    await makeGame(Difficulty.Hard, 6);
    nation.buildUnit(UnitType.MissileSilo, game.ref(60, 60), {});
    enemy.buildUnit(UnitType.City, game.ref(140, 40), {});
    // Fill the build wish list first, so the attack ticks go to strikes.
    const behavior = new NationSpecialUnitsBehavior(game, nation);
    actFor(behavior, 10);

    // Stand in for an ongoing land war against the enemy.
    nation.createAttack(enemy, 1_000, null, new Set());

    const fired = new Set<number>();
    for (let i = 0; i < 60; i++) {
      behavior.act(game.ticks());
      executeTicks(game, 2);
      for (const type of [
        UnitType.CruiseMissile,
        UnitType.NeutronBomb,
        UnitType.ClusterBomb,
        UnitType.TacticalMissile,
      ]) {
        for (const u of nation.units(type)) fired.add(u.id());
      }
    }
    expect(fired.size).toBeGreaterThan(0);
  });

  test("tactical missiles go for the enemy's defense posts", async () => {
    await makeGame(Difficulty.Hard, 6);
    nation.buildUnit(UnitType.MissileSilo, game.ref(60, 60), {});
    enemy.buildUnit(UnitType.DefensePost, game.ref(140, 40), {});
    const behavior = new NationSpecialUnitsBehavior(game, nation);
    actFor(behavior, 10);
    nation.createAttack(enemy, 1_000, null, new Set());

    let tactical = 0;
    for (let i = 0; i < 80 && tactical === 0; i++) {
      behavior.act(game.ticks());
      executeTicks(game, 1);
      tactical += nation.units(UnitType.TacticalMissile).length;
    }
    expect(tactical).toBeGreaterThan(0);
  });
});
