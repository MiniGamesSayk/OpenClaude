import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  PlayerBuildableUnitType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Game, Player, Unit } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";

/** Cities a nation owns before it spends on the newer units at all. */
const MIN_CITIES = 4;

/**
 * Gold a nation keeps after a purchase, as a multiple of its price, so the
 * newer units only take spare gold and never starve the core build order.
 */
const SPARE_GOLD_MULTIPLE = 3n;

/** Odds (1 in N) that an attack tick ends in a special-warhead strike. */
const STRIKE_ODDS = 3;

/** Cities a nation owns before it builds an airbase for paratroopers. */
const AIRBASE_MIN_CITIES = 6;

/**
 * How far from an anchor building (city or port) a new building is looked
 * for. The spot search around a tile can't land within structureMinDist of
 * the anchor itself, so the search starts this far away.
 */
const ANCHOR_OFFSET = 30;
const SPOT_ATTEMPTS = 6;

/**
 * The nations' use of the newer buildings and special warheads. Stateless
 * and on its own PRNG (seeded from the tick and the nation), so it neither
 * needs a snapshot nor shifts the random draws of the other nation
 * behaviors. Easy nations never use it.
 */
export class NationSpecialUnitsBehavior {
  constructor(
    private game: Game,
    private player: Player,
  ) {}

  /** Runs on the nation's attack ticks. */
  act(ticks: number): void {
    if (
      !this.player.isAlive() ||
      this.game.inSpawnPhase() ||
      this.game.config().gameConfig().difficulty === Difficulty.Easy ||
      this.player.unitsOwned(UnitType.City) < MIN_CITIES
    ) {
      return;
    }
    const rand = new PseudoRandom(ticks * 131 + this.player.smallID());
    if (!this.maybeBuildStructure(rand)) {
      this.maybeStrike(rand);
    }
  }

  private maybeBuildStructure(rand: PseudoRandom): boolean {
    const cities = this.player.unitsOwned(UnitType.City);
    const wants: Array<[PlayerBuildableUnitType, number]> = [
      [UnitType.Hospital, Math.min(3, Math.floor(cities / 3))],
      [UnitType.Bank, Math.min(3, Math.floor(cities / 3))],
    ];
    if (this.enemySilosExist()) {
      wants.push([UnitType.Bunker, Math.min(2, Math.floor(cities / 4))]);
    }
    if (cities >= AIRBASE_MIN_CITIES) {
      wants.push([UnitType.Airbase, 1]);
    }
    const ports = this.player.units(UnitType.Port);
    if (ports.length > 0) {
      wants.push([
        UnitType.CoastalBattery,
        Math.min(2, Math.ceil(ports.length / 2)),
      ]);
    }
    for (const [type, target] of wants) {
      if (this.player.units(type).length >= target) continue;
      const anchors =
        type === UnitType.CoastalBattery
          ? ports
          : this.player.units(UnitType.City);
      const anchor = this.pick(rand, anchors);
      if (anchor === null) continue;
      // A coastal battery searches the shore around a port by itself.
      if (type === UnitType.CoastalBattery) {
        if (this.tryBuild(type, anchor.tile())) return true;
        continue;
      }
      const spot = this.ownTileNear(rand, anchor.tile());
      if (spot !== null && this.tryBuild(type, spot)) return true;
    }
    return false;
  }

  private maybeStrike(rand: PseudoRandom): void {
    if (!rand.chance(STRIKE_ODDS)) return;
    const enemy = this.currentEnemy();
    if (enemy === null) return;

    // Drop paratroopers behind the front when an airbase is in range.
    if (rand.chance(3)) {
      const city = this.pick(rand, enemy.units(UnitType.City));
      if (city !== null && this.tryBuild(UnitType.Paratroopers, city.tile())) {
        return;
      }
    }

    // Open the enemy's air defense: an EMP over a SAM cluster, else a cheap
    // precise strike on a SAM, else a strike on one of its cities.
    const sams = enemy.units(UnitType.SAMLauncher);
    if (sams.length >= 2 && rand.chance(2)) {
      const sam = this.pick(rand, sams);
      if (sam !== null && this.tryBuild(UnitType.EMPBomb, sam.tile())) return;
    }
    // Tactical missiles take out the defense posts holding the front.
    const posts = enemy.units(UnitType.DefensePost);
    if (posts.length > 0 && rand.chance(2)) {
      const post = this.pick(rand, posts);
      if (
        post !== null &&
        this.tryBuild(UnitType.TacticalMissile, post.tile())
      ) {
        return;
      }
    }
    const targets = sams.length > 0 ? sams : enemy.units(UnitType.City);
    const target = this.pick(rand, targets);
    if (target === null) return;
    if (rand.chance(3) && this.tryBuild(UnitType.NeutronBomb, target.tile())) {
      return;
    }
    if (rand.chance(2) && this.tryBuild(UnitType.ClusterBomb, target.tile())) {
      return;
    }
    this.tryBuild(UnitType.CruiseMissile, target.tile());
  }

  /** A tile of ours a little away from `tile`, or null if none was found. */
  private ownTileNear(rand: PseudoRandom, tile: TileRef): TileRef | null {
    const x = this.game.x(tile);
    const y = this.game.y(tile);
    for (let i = 0; i < SPOT_ATTEMPTS; i++) {
      const nx = x + rand.nextInt(-ANCHOR_OFFSET, ANCHOR_OFFSET + 1);
      const ny = y + rand.nextInt(-ANCHOR_OFFSET, ANCHOR_OFFSET + 1);
      if (!this.game.isValidCoord(nx, ny)) continue;
      const t = this.game.ref(nx, ny);
      if (this.game.owner(t) === this.player) return t;
    }
    return null;
  }

  /** The player this nation is attacking with the most troops, if any. */
  private currentEnemy(): Player | null {
    let best: Player | null = null;
    let bestTroops = 0;
    for (const attack of this.player.outgoingAttacks()) {
      const target = attack.target();
      if (!target.isPlayer() || this.player.isFriendly(target)) continue;
      if (attack.troops() > bestTroops) {
        best = target;
        bestTroops = attack.troops();
      }
    }
    return best;
  }

  private enemySilosExist(): boolean {
    for (const silo of this.game.units(UnitType.MissileSilo)) {
      if (!this.player.isFriendly(silo.owner())) return true;
    }
    return false;
  }

  private tryBuild(type: PlayerBuildableUnitType, tile: TileRef): boolean {
    const cost = this.game.unitInfo(type).cost(this.game, this.player);
    if (this.player.gold() < cost * SPARE_GOLD_MULTIPLE) return false;
    if (this.player.canBuild(type, tile) === false) return false;
    this.game.addExecution(new ConstructionExecution(this.player, type, tile));
    return true;
  }

  private pick(rand: PseudoRandom, units: readonly Unit[]): Unit | null {
    return units.length === 0 ? null : units[rand.nextInt(0, units.length)];
  }
}
