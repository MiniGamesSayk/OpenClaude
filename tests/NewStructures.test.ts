import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { CoastalBatteryExecution } from "@openfront/engine/execution/CoastalBatteryExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { TestConfig } from "./util/TestConfig";
import { executeTicks } from "./util/utils";

let game: Game;
let p1: Player;
let p2: Player;

function players(): PlayerInfo[] {
  return [
    new PlayerInfo("p1", PlayerType.Human, null, "p1"),
    new PlayerInfo("p2", PlayerType.Human, null, "p2"),
  ];
}

function conquerSquare(p: Player, cx: number, cy: number, r: number) {
  for (let x = cx - r; x <= cx + r; x++) {
    for (let y = cy - r; y <= cy + r; y++) {
      if (game.isValidCoord(x, y) && game.isLand(game.ref(x, y))) {
        p.conquer(game.ref(x, y));
      }
    }
  }
}

describe("Hospital", () => {
  beforeEach(async () => {
    game = await setup("plains", { infiniteGold: true, instantBuild: true }, [
      ...players(),
    ]);
    p1 = game.player("p1");
    conquerSquare(p1, 20, 20, 10);
    p1.addTroops(20_000);
  });

  test("finished hospitals speed up troop regeneration", () => {
    const config = game.config();
    const base = config.troopIncreaseRate(p1);
    expect(base).toBeGreaterThan(0);

    const hospital = p1.buildUnit(UnitType.Hospital, game.ref(20, 20), {});
    const one = config.troopIncreaseRate(p1);
    expect(one).toBeCloseTo(base * (1 + config.hospitalRegenBonus(1)), 6);

    hospital.increaseLevel();
    expect(config.troopIncreaseRate(p1)).toBeGreaterThan(one);
  });

  test("a hospital under construction does nothing yet", () => {
    const config = game.config();
    const base = config.troopIncreaseRate(p1);
    const hospital = p1.buildUnit(UnitType.Hospital, game.ref(20, 20), {});
    hospital.setUnderConstruction(true);
    expect(config.troopIncreaseRate(p1)).toBe(base);
  });

  test("regeneration still stops at the troop cap", () => {
    const config = game.config();
    p1.buildUnit(UnitType.Hospital, game.ref(20, 20), {});
    p1.addTroops(config.maxTroops(p1));
    expect(config.troopIncreaseRate(p1)).toBeLessThanOrEqual(0);
  });
});

describe("Bank", () => {
  beforeEach(async () => {
    game = await setup("plains", { infiniteGold: true, instantBuild: true }, [
      ...players(),
    ]);
    p1 = game.player("p1");
    conquerSquare(p1, 20, 20, 10);
  });

  test("each finished bank level adds gold every tick", () => {
    const config = game.config();
    const base = config.goldAdditionRate(p1);
    const perLevel = BigInt(config.bankGoldPerLevel());

    const bank = p1.buildUnit(UnitType.Bank, game.ref(20, 20), {});
    expect(config.goldAdditionRate(p1)).toBe(base + perLevel);
    bank.increaseLevel();
    expect(config.goldAdditionRate(p1)).toBe(base + 2n * perLevel);

    bank.setUnderConstruction(true);
    expect(config.goldAdditionRate(p1)).toBe(base);
  });

  test("bank is built through the build menu path and costs gold", async () => {
    game = await setup("plains", { infiniteGold: false, instantBuild: true }, [
      ...players(),
    ]);
    p1 = game.player("p1");
    conquerSquare(p1, 20, 20, 10);
    const cost = game.unitInfo(UnitType.Bank).cost(game, p1);
    expect(cost).toBeGreaterThan(0n);
    p1.addGold(cost);

    game.addExecution(
      new ConstructionExecution(p1, UnitType.Bank, game.ref(20, 20)),
    );
    executeTicks(game, 3);
    expect(p1.units(UnitType.Bank)).toHaveLength(1);
    expect(p1.gold()).toBeLessThan(cost);
    // The next bank costs more.
    expect(game.unitInfo(UnitType.Bank).cost(game, p1)).toBeGreaterThan(cost);
  });
});

describe("Coastal battery", () => {
  const coastX = 7;

  beforeEach(async () => {
    game = await setup(
      "half_land_half_ocean",
      { infiniteGold: true, instantBuild: true },
      players(),
    );
    p1 = game.player("p1");
    p2 = game.player("p2");
    conquerSquare(p1, 3, 8, 8);
  });

  test("must be built on the coast", () => {
    expect(p1.canBuild(UnitType.CoastalBattery, game.ref(coastX, 8))).not.toBe(
      false,
    );
    expect(p1.canBuild(UnitType.CoastalBattery, game.ref(1, 8))).toBe(false);
  });

  test("sinks enemy invasion boats and damages warships in range", () => {
    game.addExecution(
      new ConstructionExecution(
        p1,
        UnitType.CoastalBattery,
        game.ref(coastX, 8),
      ),
    );
    executeTicks(game, 3);
    expect(p1.units(UnitType.CoastalBattery)).toHaveLength(1);

    const boat = p2.buildUnit(UnitType.TransportShip, game.ref(coastX + 2, 8), {
      troops: 100,
    });
    const warship = p2.buildUnit(UnitType.Warship, game.ref(coastX + 3, 10), {
      patrolTile: game.ref(coastX + 3, 10),
    });
    const fullHealth = warship.health();

    // Invasion boats are shot first: one shell sinks the boat...
    executeTicks(game, 5);
    expect(boat.isActive()).toBe(false);
    expect(warship.health()).toBe(fullHealth);

    // ...and the warship takes the next one after the reload.
    executeTicks(game, game.config().coastalBatteryCooldown() + 5);
    expect(warship.health()).toBeLessThan(fullHealth);
  });

  test("ignores its owner's ships", () => {
    const battery = p1.buildUnit(
      UnitType.CoastalBattery,
      game.ref(coastX, 8),
      {},
    );
    game.addExecution(new CoastalBatteryExecution(battery));
    const boat = p1.buildUnit(UnitType.TransportShip, game.ref(coastX + 2, 8), {
      troops: 100,
    });
    executeTicks(game, 10);
    expect(boat.isActive()).toBe(true);
    expect(battery.missileTimerQueue()).toHaveLength(0);
  });
});

class ShortRangeConfig extends TestConfig {
  override paratrooperRange(): number {
    return 30;
  }
}

describe("Airbase and paratroopers", () => {
  async function makeGame(configClass: typeof TestConfig = TestConfig) {
    game = await setup(
      "plains",
      { infiniteGold: true, instantBuild: true },
      players(),
      undefined,
      configClass,
    );
    p1 = game.player("p1");
    p2 = game.player("p2");
    conquerSquare(p1, 10, 10, 5);
    conquerSquare(p2, 60, 60, 10);
    p1.addTroops(50_000);
    game.addExecution(
      new ConstructionExecution(p1, UnitType.Airbase, game.ref(10, 10)),
    );
    executeTicks(game, 3);
  }

  test("drop needs a ready airbase in range and an attackable target", async () => {
    await makeGame(ShortRangeConfig);
    const airbase = p1.units(UnitType.Airbase)[0];
    expect(airbase).toBeDefined();
    // In range of the airbase.
    expect(p1.canBuild(UnitType.Paratroopers, game.ref(30, 10))).toBe(
      airbase.tile(),
    );
    // Too far.
    expect(p1.canBuild(UnitType.Paratroopers, game.ref(60, 60))).toBe(false);
    // Own land.
    expect(p1.canBuild(UnitType.Paratroopers, game.ref(11, 11))).toBe(false);
  });

  test("paratroopers fly over and open an attack where they land", async () => {
    await makeGame();
    const airbase = p1.units(UnitType.Airbase)[0];
    const target = game.ref(60, 60);
    const troopsBefore = p1.troops();

    game.addExecution(
      new ConstructionExecution(p1, UnitType.Paratroopers, target),
    );
    let inFlight = false;
    for (let i = 0; i < 10 && !inFlight; i++) {
      game.executeNextTick();
      inFlight = p1.units(UnitType.Paratroopers).length > 0;
    }
    expect(inFlight).toBe(true);
    const plane = p1.units(UnitType.Paratroopers)[0];
    expect(plane.troops()).toBeGreaterThan(0);
    expect(p1.troops()).toBeLessThan(troopsBefore);
    expect(airbase.isInCooldown()).toBe(true);
    // Not a boat: the drop is not where the plane is.
    expect(game.owner(target)).toBe(p2);

    for (let i = 0; i < 300 && plane.isActive(); i++) {
      game.executeNextTick();
    }
    expect(plane.isActive()).toBe(false);
    expect(game.owner(target)).toBe(p1);
    expect(p1.outgoingAttacks().some((a) => a.target() === p2)).toBe(true);
  });

  test("the airbase reloads its drop", async () => {
    await makeGame();
    const airbase = p1.units(UnitType.Airbase)[0];
    game.addExecution(
      new ConstructionExecution(p1, UnitType.Paratroopers, game.ref(60, 60)),
    );
    executeTicks(game, 4);
    expect(airbase.isInCooldown()).toBe(true);
    executeTicks(game, game.config().airbaseCooldown() + 2);
    expect(airbase.isInCooldown()).toBe(false);
  });
});
