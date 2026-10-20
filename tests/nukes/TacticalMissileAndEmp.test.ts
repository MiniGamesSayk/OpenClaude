import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  Config,
  NukeMagnitude,
} from "@openfront/engine-lib/configuration/Config";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { MissileSiloExecution } from "@openfront/engine/execution/MissileSiloExecution";
import { NukeExecution } from "@openfront/engine/execution/NukeExecution";
import { SAMLauncherExecution } from "@openfront/engine/execution/SAMLauncherExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "../util/Setup";
import { TestConfig } from "../util/TestConfig";
import { executeTicks } from "../util/utils";

// TestConfig shrinks every blast to radius 1; these tests need the real ones.
class RealBlastConfig extends TestConfig {
  override nukeMagnitudes(type: UnitType): NukeMagnitude {
    return Config.prototype.nukeMagnitudes.call(this, type);
  }
}

const CENTER = 60;

let game: Game;
let attacker: Player;
let defender: Player;

/** Conquers the size×size square whose top-left tile is (x0, y0). */
function conquerSquare(player: Player, x0: number, y0: number, size: number) {
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      player.conquer(game.ref(x, y));
    }
  }
}

/** Ticks until `exec` is done (detonated or gone); fails after `max`. */
function runUntilDone(exec: NukeExecution, max = 300): void {
  for (let i = 0; i < max; i++) {
    game.executeNextTick();
    if (!exec.isActive()) return;
  }
  throw new Error("missile never detonated");
}

describe("Tactical missile and EMP bomb", () => {
  beforeEach(async () => {
    game = await setup(
      "big_plains",
      { infiniteGold: true, instantBuild: true },
      [
        new PlayerInfo("attacker", PlayerType.Human, "c1", "attacker_id"),
        new PlayerInfo("defender", PlayerType.Human, "c2", "defender_id"),
      ],
      undefined,
      RealBlastConfig,
    );
    attacker = game.player("attacker_id");
    defender = game.player("defender_id");

    conquerSquare(attacker, 5, 5, 11);
    attacker.buildUnit(UnitType.MissileSilo, game.ref(10, 10), {});
    conquerSquare(defender, 40, 40, 41);
  });

  test("real config values", () => {
    const config = new EngineConfig({} as unknown as GameConfig, false);
    expect(config.nukeMagnitudes(UnitType.TacticalMissile)).toEqual({
      inner: 5,
      outer: 8,
    });
    expect(config.nukeMagnitudes(UnitType.EMPBomb)).toEqual({
      inner: 0,
      outer: 50,
    });
    expect(config.nukeSpeed(UnitType.TacticalMissile)).toBe(14);
    expect(config.nukeSpeed(UnitType.EMPBomb)).toBe(12);
    expect(config.unitInfo(UnitType.TacticalMissile).cost(game, attacker)).toBe(
      200_000n,
    );
    expect(config.unitInfo(UnitType.EMPBomb).cost(game, attacker)).toBe(
      1_000_000n,
    );
  });

  test("tactical missile only destroys a small area", () => {
    const center = defender.buildUnit(
      UnitType.City,
      game.ref(CENTER, CENTER),
      {},
    );
    const farCity = defender.buildUnit(
      UnitType.City,
      game.ref(CENTER + 15, CENTER),
      {},
    );
    const tilesBefore = defender.numTilesOwned();

    const exec = new NukeExecution(
      UnitType.TacticalMissile,
      attacker,
      game.ref(CENTER, CENTER),
    );
    game.addExecution(exec);
    runUntilDone(exec);

    // Everything within the inner radius (5) is gone...
    expect(game.owner(game.ref(CENTER, CENTER))).not.toBe(defender);
    expect(game.owner(game.ref(CENTER + 4, CENTER))).not.toBe(defender);
    // ...nothing past the outer radius (8) is touched.
    expect(game.owner(game.ref(CENTER + 10, CENTER))).toBe(defender);
    const lost = tilesBefore - defender.numTilesOwned();
    expect(lost).toBeGreaterThanOrEqual(81); // at least the inner disk
    expect(lost).toBeLessThanOrEqual(225); // at most the outer disk
    expect(center.isActive()).toBe(false);
    expect(farCity.isActive()).toBe(true);
  });

  test("EMP destroys no land and knocks out only enemy SAMs and silos", () => {
    const sam = defender.buildUnit(
      UnitType.SAMLauncher,
      game.ref(CENTER, CENTER),
      {},
    );
    game.addExecution(new SAMLauncherExecution(defender, null, sam));
    const silo = defender.buildUnit(
      UnitType.MissileSilo,
      game.ref(CENTER + 5, CENTER),
      {},
    );
    game.addExecution(new MissileSiloExecution(silo));
    const farSam = defender.buildUnit(
      UnitType.SAMLauncher,
      game.ref(CENTER, CENTER + 55),
      {},
    );
    // The attacker's own SAM inside the pulse is not affected.
    attacker.conquer(game.ref(CENTER, CENTER + 30));
    const ownSam = attacker.buildUnit(
      UnitType.SAMLauncher,
      game.ref(CENTER, CENTER + 30),
      {},
    );
    const warship = defender.buildUnit(
      UnitType.Warship,
      game.ref(CENTER + 2, CENTER + 2),
      { patrolTile: game.ref(CENTER + 2, CENTER + 2) },
    );
    const tilesBefore = defender.numTilesOwned();
    const troopsBefore = defender.troops();

    const exec = new NukeExecution(
      UnitType.EMPBomb,
      attacker,
      game.ref(CENTER, CENTER),
    );
    game.addExecution(exec);
    let samMissilesSeen = 0;
    for (let i = 0; i < 300 && exec.isActive(); i++) {
      game.executeNextTick();
      samMissilesSeen += defender.units(UnitType.SAMMissile).length;
    }
    expect(exec.isActive()).toBe(false);
    const detonationTick = game.ticks();

    // SAMs never fire at an EMP bomb.
    expect(samMissilesSeen).toBe(0);
    // No land, no troops, no buildings lost.
    expect(defender.numTilesOwned()).toBe(tilesBefore);
    expect(defender.troops()).toBeGreaterThanOrEqual(troopsBefore);
    expect(sam.isActive()).toBe(true);
    expect(silo.isActive()).toBe(true);

    const reloadStart = game.config().empDisableExtraTicks();
    for (const launcher of [sam, silo]) {
      expect(launcher.isInCooldown()).toBe(true);
      for (const t of launcher.missileTimerQueue()) {
        expect(t).toBeGreaterThanOrEqual(detonationTick - 1 + reloadStart);
      }
    }
    expect(farSam.isInCooldown()).toBe(false);
    expect(ownSam.isInCooldown()).toBe(false);
    expect(warship.health()).toBe(
      warship.maxHealth() -
        Math.floor(
          (warship.maxHealth() * game.config().empWarshipDamagePercent()) / 100,
        ),
    );

    // The knock-out wears off: the extra delay, then a normal reload.
    executeTicks(game, reloadStart + game.config().SAMCooldown() + 2);
    expect(sam.isInCooldown()).toBe(false);
    expect(silo.isInCooldown()).toBe(false);
  });

  test("EMP leaves allied launchers alone", () => {
    attacker.createAllianceRequest(defender)?.accept();
    expect(attacker.isAlliedWith(defender)).toBe(true);

    const sam = defender.buildUnit(
      UnitType.SAMLauncher,
      game.ref(CENTER, CENTER),
      {},
    );
    const exec = new NukeExecution(
      UnitType.EMPBomb,
      attacker,
      game.ref(CENTER, CENTER),
    );
    game.addExecution(exec);
    runUntilDone(exec);
    expect(sam.isInCooldown()).toBe(false);
    // An EMP never breaks the alliance.
    expect(attacker.isAlliedWith(defender)).toBe(true);
  });

  test("SAMs shoot down tactical missiles but never target EMP bombs", () => {
    const sam = defender.buildUnit(UnitType.SAMLauncher, game.ref(41, 41), {});
    game.addExecution(new SAMLauncherExecution(defender, null, sam));
    const trajectory = [
      { tile: game.ref(41, 41), targetable: true },
      { tile: game.ref(42, 41), targetable: true },
      { tile: game.ref(43, 41), targetable: true },
    ];
    const emp: Unit = attacker.buildUnit(UnitType.EMPBomb, game.ref(41, 41), {
      targetTile: game.ref(43, 41),
      trajectory,
    });
    executeTicks(game, 3);
    expect(emp.isActive()).toBe(true);
    expect(sam.isInCooldown()).toBe(false);

    emp.delete(false);
    attacker.buildUnit(UnitType.TacticalMissile, game.ref(41, 41), {
      targetTile: game.ref(43, 41),
      trajectory,
    });
    executeTicks(game, 3);
    expect(attacker.units(UnitType.TacticalMissile)).toHaveLength(0);
  });
});
