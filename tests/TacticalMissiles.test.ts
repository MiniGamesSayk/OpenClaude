import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  Config,
  NukeMagnitude,
} from "@openfront/engine-lib/configuration/Config";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { SAMLauncherExecution } from "@openfront/engine/execution/SAMLauncherExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { TestConfig } from "./util/TestConfig";

/** TestConfig shrinks every blast to 1 tile; these tests need the real ones. */
class RealBlastConfig extends TestConfig {
  override nukeMagnitudes(type: UnitType): NukeMagnitude {
    return Config.prototype.nukeMagnitudes.call(this, type);
  }
}

const TARGET_X = 60;
const TARGET_Y = 60;

let game: Game;
let attacker: Player;
let defender: Player;

function conquerSquare(p: Player, cx: number, cy: number, r: number) {
  for (let x = cx - r; x <= cx + r; x++) {
    for (let y = cy - r; y <= cy + r; y++) {
      if (game.isValidCoord(x, y)) p.conquer(game.ref(x, y));
    }
  }
}

async function makeGame(): Promise<void> {
  const attackerInfo = new PlayerInfo(
    "attacker",
    PlayerType.Human,
    null,
    "attacker",
  );
  const defenderInfo = new PlayerInfo(
    "defender",
    PlayerType.Human,
    null,
    "defender",
  );
  game = await setup(
    "big_plains",
    { infiniteGold: true, instantBuild: true },
    [attackerInfo, defenderInfo],
    undefined,
    RealBlastConfig,
  );
  attacker = game.player(attackerInfo.id);
  defender = game.player(defenderInfo.id);
  conquerSquare(attacker, 5, 5, 4);
  attacker.buildUnit(UnitType.MissileSilo, game.ref(5, 5), {});
  conquerSquare(defender, TARGET_X, TARGET_Y, 25);
  defender.addTroops(100_000);
}

function launch(type: UnitType, tile: TileRef = game.ref(TARGET_X, TARGET_Y)) {
  game.addExecution(new ConstructionExecution(attacker, type, tile));
}

/** Runs until the warhead of `type` has taken off and landed (or been shot down). */
function runUntilLanded(type: UnitType): void {
  let launched = false;
  for (let i = 0; i < 500; i++) {
    game.executeNextTick();
    const inFlight = game.unitCount(type) > 0;
    if (inFlight) launched = true;
    if (launched && !inFlight) return;
  }
  throw new Error(`${type} never ${launched ? "landed" : "launched"}`);
}

describe("Tactical missiles", () => {
  beforeEach(makeGame);

  test("every tactical missile launches from a silo", () => {
    for (const type of [
      UnitType.CruiseMissile,
      UnitType.NeutronBomb,
      UnitType.EMPBomb,
      UnitType.ClusterBomb,
    ]) {
      const target = game.ref(TARGET_X, TARGET_Y);
      expect(attacker.canBuild(type, target)).toBe(game.ref(5, 5));
    }
  });

  test("cannot launch without a silo", () => {
    for (const silo of attacker.units(UnitType.MissileSilo)) silo.delete();
    expect(
      attacker.canBuild(UnitType.CruiseMissile, game.ref(TARGET_X, TARGET_Y)),
    ).toBe(false);
  });

  test("cruise missile destroys buildings but keeps the land and leaves no fallout", () => {
    const target = game.ref(TARGET_X, TARGET_Y);
    const city = defender.buildUnit(UnitType.City, target, {});
    const farCity = defender.buildUnit(
      UnitType.City,
      game.ref(TARGET_X + 20, TARGET_Y),
      {},
    );
    const tilesBefore = defender.numTilesOwned();

    launch(UnitType.CruiseMissile);
    runUntilLanded(UnitType.CruiseMissile);

    expect(city.isActive()).toBe(false);
    expect(farCity.isActive()).toBe(true);
    expect(game.owner(target)).toBe(defender);
    expect(game.hasFallout(target)).toBe(false);
    expect(defender.numTilesOwned()).toBe(tilesBefore);
  });

  test("neutron bomb kills troops but spares land and buildings", () => {
    const target = game.ref(TARGET_X, TARGET_Y);
    const city = defender.buildUnit(UnitType.City, target, {});
    const troopsBefore = defender.troops();
    const tilesBefore = defender.numTilesOwned();

    launch(UnitType.NeutronBomb);
    runUntilLanded(UnitType.NeutronBomb);

    expect(city.isActive()).toBe(true);
    expect(game.owner(target)).toBe(defender);
    expect(defender.numTilesOwned()).toBe(tilesBefore);
    expect(defender.troops()).toBeLessThan(troopsBefore * 0.5);
  });

  test("EMP jams launchers longer than a normal reload, without damage", () => {
    const target = game.ref(TARGET_X, TARGET_Y);
    const sam = defender.buildUnit(UnitType.SAMLauncher, target, {});
    const silo = defender.buildUnit(
      UnitType.MissileSilo,
      game.ref(TARGET_X + 10, TARGET_Y),
      {},
    );
    const city = defender.buildUnit(
      UnitType.City,
      game.ref(TARGET_X - 10, TARGET_Y),
      {},
    );
    const troopsBefore = defender.troops();
    const tilesBefore = defender.numTilesOwned();

    launch(UnitType.EMPBomb);
    runUntilLanded(UnitType.EMPBomb);

    expect(sam.isActive()).toBe(true);
    expect(silo.isActive()).toBe(true);
    expect(city.isActive()).toBe(true);
    expect(sam.isInCooldown()).toBe(true);
    expect(silo.isInCooldown()).toBe(true);
    // Jammed past the end of a normal reload.
    expect(sam.missileTimerQueue()[0]).toBeGreaterThan(game.ticks());
    expect(defender.troops()).toBe(troopsBefore);
    expect(defender.numTilesOwned()).toBe(tilesBefore);
  });

  test("EMP leaves the attacker's own launchers alone", () => {
    const ownSilo = attacker.buildUnit(
      UnitType.MissileSilo,
      game.ref(TARGET_X, TARGET_Y + 5),
      {},
    );
    launch(UnitType.EMPBomb);
    runUntilLanded(UnitType.EMPBomb);
    // It is the closest silo, so it fired the EMP and is reloading normally,
    // but its reload was not pushed into the future by its own blast.
    expect(ownSilo.isActive()).toBe(true);
    for (const firedAt of ownSilo.missileTimerQueue()) {
      expect(firedAt).toBeLessThanOrEqual(game.ticks());
    }
  });

  test("cluster bomb scatters several small blasts over the target area", () => {
    const target = game.ref(TARGET_X, TARGET_Y);
    const tilesBefore = defender.numTilesOwned();

    launch(UnitType.ClusterBomb);
    runUntilLanded(UnitType.ClusterBomb);

    const lost = tilesBefore - defender.numTilesOwned();
    const area = game.config().nukeMagnitudes(UnitType.ClusterBomb);
    const sub = game.config().clusterSubmunitionMagnitude();
    // More than one sub-blast landed, but far less than one big blast.
    expect(lost).toBeGreaterThan(Math.PI * sub.inner * sub.inner);
    expect(lost).toBeLessThan(Math.PI * area.outer * area.outer * 0.8);
    // Nothing outside the scatter area was touched.
    const r = area.outer + 1;
    for (let x = TARGET_X - 25; x <= TARGET_X + 25; x++) {
      for (let y = TARGET_Y - 25; y <= TARGET_Y + 25; y++) {
        const t = game.ref(x, y);
        if (game.euclideanDistSquared(t, target) > r * r) {
          expect(game.owner(t)).toBe(defender);
        }
      }
    }
  });

  test("SAMs shoot tactical missiles down", () => {
    const target = game.ref(TARGET_X, TARGET_Y);
    const sam = defender.buildUnit(UnitType.SAMLauncher, target, {});
    game.addExecution(new SAMLauncherExecution(defender, null, sam));
    const city = defender.buildUnit(
      UnitType.City,
      game.ref(TARGET_X + 2, TARGET_Y),
      {},
    );

    launch(UnitType.CruiseMissile, game.ref(TARGET_X + 2, TARGET_Y));
    runUntilLanded(UnitType.CruiseMissile);

    expect(city.isActive()).toBe(true);
    expect(sam.isActive()).toBe(true);
  });
});

describe("Bunker", () => {
  beforeEach(makeGame);

  async function neutronLosses(withBunker: boolean): Promise<number> {
    await makeGame();
    if (withBunker) {
      const bunker = defender.buildUnit(
        UnitType.Bunker,
        game.ref(TARGET_X + 24, TARGET_Y + 24),
        {},
      );
      bunker.increaseLevel();
    }
    const before = defender.troops();
    launch(UnitType.NeutronBomb);
    runUntilLanded(UnitType.NeutronBomb);
    return before - defender.troops();
  }

  test("bunkers shelter troops from bombs", async () => {
    const unprotected = await neutronLosses(false);
    const sheltered = await neutronLosses(true);
    expect(unprotected).toBeGreaterThan(0);
    expect(sheltered).toBeLessThan(unprotected);
  });

  test("protection grows with levels and is capped", () => {
    const config = game.config();
    expect(config.bunkerProtection(0)).toBe(0);
    expect(config.bunkerProtection(2)).toBeGreaterThan(
      config.bunkerProtection(1),
    );
    expect(config.bunkerProtection(100)).toBeLessThan(1);
  });
});
