import {
  Difficulty,
  GameType,
  PlayerType,
  Tick,
  UnitInfo,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PlayerLike } from "@openfront/engine-api/game/ReadViews";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { pow } from "../DetMath";
import { DoomsdayClockSpeed } from "../game/DoomsdayClock";
import { assertNever } from "../Util";

export interface NukeMagnitude {
  inner: number;
  outer: number;
}

/**
 * What a silo-launched warhead does on impact. Nuclear warheads do it all;
 * the special warheads each keep a part of it. (The EMP bomb destroys nothing
 * and has its own pulse, see NukeExecution.detonateEmp.)
 */
export interface WarheadProfile {
  /** Tiles in the blast are relinquished and left as fallout (or water). */
  destroysTerritory: boolean;
  /** Structures in the blast are destroyed. */
  destroysStructures: boolean;
  /** Ships, boats, trains and other mobile units in the blast are destroyed. */
  destroysMobileUnits: boolean;
  /** Scales the nuke troop losses on every owned tile hit; 0 = no losses. */
  troopDeathMultiplier: number;
  /**
   * > 0: the warhead splits over the target into this many sub-blasts of
   * clusterSubmunitionMagnitude(), scattered inside its own magnitude.
   */
  submunitions: number;
}

const NUCLEAR_WARHEAD: WarheadProfile = {
  destroysTerritory: true,
  destroysStructures: true,
  destroysMobileUnits: true,
  troopDeathMultiplier: 1,
  submunitions: 0,
};

const DEFAULT_SPAWN_IMMUNITY_TICKS = 5 * 10;

/** SAM launcher construction duration in ticks (non-instant-build). */
export const SAM_CONSTRUCTION_TICKS = 30 * 10;

// Doomsday Clock tunables (anti-stall). Off unless enabled in GameConfig.
// Times in seconds. The required map share rises in waves (levels + times in
// DoomsdayClock.ts, chosen by `speed`). A side caught below the bar gets a
// warnSeconds cooldown ("Danger, decay in Xs"), then troops bleed DOWN TO A
// FLOOR (drainFloorPercent of max), not to zero: the warn (30s) + the linear
// drain (~90s from full troops, sooner with fewer troops or a shrinking
// territory) make ~2 minutes from caught to the floor. A doomed side is crippled
// to 5% of max, not eliminated, so a brief dip below the bar is recoverable (the
// drain stops the moment it climbs back); the rising bar still guarantees a
// finish by squeezing territory and leaving the doomed side easy to conquer.
const DOOMSDAY_CLOCK_DEFAULTS = {
  enabled: false,
  speed: "normal" as DoomsdayClockSpeed,
  warnSeconds: 30, // cooldown (the flashing danger cue) before decay begins
  drainStartPercent: 2, // starts bleeding at once (already beats troop income)
  drainMaxPercent: 5,
  drainRampSeconds: 90, // ramps LINEARLY to the max over this long
  drainFloorPercent: 5, // drain settles here: crippled to 5% of max, never wiped
  // The floor decays start -> drainFloorPercent over floorDecaySeconds, leaving
  // one comeback window with a usable army. It must not be permanent: maxTroops is
  // sublinear (~100k at one tile), so a fixed 40% is ~40k troops on a single tile.
  floorStartPercent: 40,
  floorDecaySeconds: 90,
  // TERRITORY ROT — the finisher, since the drain never kills. rotDeathSeconds is
  // a DEADLINE, not a rate: the territory is gone this long after the skull
  // appeared, whatever it holds. 0 disables rot. Timeline:
  //
  //   0s    skull blinks, warn countdown
  //   30s   skull steady, troops draining              (warnSeconds)
  //   120s  floor at 5%, territory rotting, skull RED  (warn + floorDecay)
  //   150s  nothing left, eliminated                   (rotDeathSeconds)
  rotDeathSeconds: 150,
  // Grainy opening: pinholes across this share of the territory before the holes
  // grow together. Held to a third of the rot window, so shortening the window
  // shortens this too: at 20s the speckle WAS the death rather than its opening.
  rotGrainSeconds: 10,
  rotSpecklePercent: 15,
  // Warships bleed on their OWN gentler start + a STEEP (convex) ramp to a much
  // higher ceiling. A ship caught when its side is first doomed lasts about as
  // long as troops (the low start + no income ≈ the troop net rate), but the rate
  // curves up sharply (warshipDrainCurveExponent), so once a side has been under
  // the clock the full ramp, ships drop to the same floor in ~2s (50%/s), not
  // sunk. Ships only.
  warshipDrainStartPercent: 1,
  warshipDrainMaxPercent: 50,
  warshipDrainCurveExponent: 8, // >1 = convex: stays gentle early, then spikes
};

// Share of the land a side must hold to win, in every game mode.
const PERCENT_TILES_OWNED_TO_WIN = 80;

// Overtime tunables (anti-stalemate). Off unless enabled in GameConfig.
// After startMinutes the percentage of tiles required to win falls from the
// base by dropPercentPerMinute, with no floor: the bar keeps sinking until the
// leading side crosses it, so a stalled game always ends. Only `enabled` and
// `startMinutes` are wire-configurable.
const OVERTIME_DEFAULTS = {
  enabled: false,
  startMinutes: 30,
  dropPercentPerMinute: 2,
};

// Mutator tunables (see MutatorsConfigSchema). Each mutator is off unless
// enabled in the GameConfig; only the on/off switches are wire-configurable.
// Times in seconds. Every value the sim reads is an integer.
export const MUTATOR_DEFAULTS = {
  // Meteor shower: once the grace period after spawn immunity is over, a
  // volley of meteors lands every meteorMinInterval..meteorMaxInterval
  // seconds on random land tiles. Bigger maps get more meteors per volley
  // (one per meteorLandTilesPerMeteor land tiles, at least one).
  meteorGraceSeconds: 60,
  meteorMinIntervalSeconds: 15,
  meteorMaxIntervalSeconds: 30,
  meteorLandTilesPerMeteor: 250_000,
  meteorMaxPerVolley: 4,
  meteorInnerRadius: 5,
  meteorOuterRadius: 10,
  // Blitz: income multipliers and build/reload divisors.
  blitzIncomeMultiplier: 2,
  blitzTimeDivisor: 2,
  // King of the hill: the hill opens hillOpenSeconds after the spawn phase.
  // A side controls it while it owns MORE than hillControlPercent of the
  // hill's land; the first side to control it for hillHoldSecondsToWin
  // seconds in total wins.
  hillOpenSeconds: 180,
  hillHoldSecondsToWin: 300,
  hillControlPercent: 50,
  hillMinRadius: 8,
  hillMaxRadius: 40,
  // Underdog: every second, a side holding less than underdogLeaderPercent
  // of the leading side's tiles earns this much extra (in percent of its
  // normal troop and gold income).
  underdogLeaderPercent: 25,
  underdogBonusPercent: 50,
};

export type ResolvedMutators = {
  meteorShower: boolean;
  blitz: boolean;
  kingOfTheHill: boolean;
  underdog: boolean;
};

export class Config {
  private unitInfoCache = new Map<UnitType, UnitInfo>();
  constructor(
    protected _gameConfig: GameConfig,
    private _isReplay: boolean,
    public readonly listed: boolean = false,
    private _spectator: boolean = false,
  ) {}

  isReplay(): boolean {
    return this._isReplay;
  }

  /** True when the player joined the lobby as a spectator (watch-only). */
  isIntentionalSpectator(): boolean {
    return this._spectator;
  }

  traitorDefenseDebuff(): number {
    return 0.5;
  }
  traitorDuration(): number {
    return 30 * 10; // 30 seconds
  }

  // Doomsday Clock config, resolved against defaults. One read per tick.
  doomsdayClockConfig(): typeof DOOMSDAY_CLOCK_DEFAULTS {
    const c = this._gameConfig.doomsdayClock;
    const d = DOOMSDAY_CLOCK_DEFAULTS;
    return {
      enabled: c?.enabled ?? d.enabled,
      speed: c?.speed ?? d.speed,
      // Drain/warn tuning is internal (not wire-configurable): always defaults.
      warnSeconds: d.warnSeconds,
      drainStartPercent: d.drainStartPercent,
      drainMaxPercent: d.drainMaxPercent,
      drainRampSeconds: d.drainRampSeconds,
      drainFloorPercent: d.drainFloorPercent,
      floorStartPercent: d.floorStartPercent,
      floorDecaySeconds: d.floorDecaySeconds,
      rotDeathSeconds: d.rotDeathSeconds,
      rotGrainSeconds: d.rotGrainSeconds,
      rotSpecklePercent: d.rotSpecklePercent,
      warshipDrainStartPercent: d.warshipDrainStartPercent,
      warshipDrainMaxPercent: d.warshipDrainMaxPercent,
      warshipDrainCurveExponent: d.warshipDrainCurveExponent,
    };
  }
  // Overtime config, resolved against defaults.
  overtimeConfig(): typeof OVERTIME_DEFAULTS {
    const c = this._gameConfig.overtime;
    const d = OVERTIME_DEFAULTS;
    return {
      enabled: c?.enabled ?? d.enabled,
      startMinutes: c?.startMinutes ?? d.startMinutes,
      // The drop rate is internal (not wire-configurable): always the default.
      dropPercentPerMinute: d.dropPercentPerMinute,
    };
  }
  // Mutator switches, resolved against "off".
  mutators(): ResolvedMutators {
    const m = this._gameConfig.mutators;
    return {
      meteorShower: m?.meteorShower ?? false,
      blitz: m?.blitz ?? false,
      kingOfTheHill: m?.kingOfTheHill ?? false,
      underdog: m?.underdog ?? false,
    };
  }
  isBlitz(): boolean {
    return this._gameConfig.mutators?.blitz ?? false;
  }
  // Divides build and reload times under the Blitz mutator.
  private blitzTime(ticks: number): number {
    return this.isBlitz()
      ? Math.floor(ticks / MUTATOR_DEFAULTS.blitzTimeDivisor)
      : ticks;
  }
  spawnImmunityDuration(): Tick {
    return (
      this._gameConfig.spawnImmunityDuration ?? DEFAULT_SPAWN_IMMUNITY_TICKS
    );
  }
  nationSpawnImmunityDuration(): Tick {
    return DEFAULT_SPAWN_IMMUNITY_TICKS;
  }
  hasExtendedSpawnImmunity(): boolean {
    return this.spawnImmunityDuration() > DEFAULT_SPAWN_IMMUNITY_TICKS;
  }

  gameConfig(): GameConfig {
    return this._gameConfig;
  }

  cityTroopIncrease(): number {
    return 250_000;
  }
  msPerTick(): number {
    return 100;
  }
  SAMCooldown(): number {
    return this.blitzTime(90);
  }
  SiloCooldown(): number {
    return this.blitzTime(90);
  }
  coastalBatteryCooldown(): number {
    return this.blitzTime(30);
  }
  airbaseCooldown(): number {
    return this.blitzTime(150);
  }

  /** Reload time of one shot of a launcher structure (LauncherStructures). */
  launcherCooldown(type: UnitType): number {
    switch (type) {
      case UnitType.SAMLauncher:
        return this.SAMCooldown();
      case UnitType.CoastalBattery:
        return this.coastalBatteryCooldown();
      case UnitType.Airbase:
        return this.airbaseCooldown();
      default:
        return this.SiloCooldown();
    }
  }

  coastalBatteryRange(): number {
    return 60;
  }

  /** Max distance from an airbase to the drop zone of its paratroopers. */
  paratrooperRange(): number {
    return 350;
  }

  paratrooperSpeed(): number {
    return 8;
  }

  /** Share of the player's troops a paratrooper drop carries. */
  paratrooperTroopShare(): number {
    return 0.2;
  }

  /** Sum of the levels of a player's finished structures of one type. */
  completedLevels(player: PlayerLike, type: UnitType): number {
    let levels = 0;
    for (const u of player.units(type)) {
      if (!u.isUnderConstruction()) levels += u.level();
    }
    return levels;
  }

  /** Extra troop regeneration from hospitals, as a fraction (0.5 = +50%). */
  hospitalRegenBonus(levels: number): number {
    return Math.min(0.6, levels * 0.12);
  }

  /** Gold a bank level adds every tick, before the gold multiplier. */
  bankGoldPerLevel(): number {
    return 40;
  }

  /** Share of nuke troop losses that bunkers prevent (0 = none, 0.6 = 60%). */
  bunkerProtection(levels: number): number {
    return Math.min(0.6, levels * 0.12);
  }

  defensePostRange(): number {
    return 30;
  }

  isUnitDisabled(unitType: UnitType): boolean {
    return this._gameConfig.disabledUnits?.includes(unitType) ?? false;
  }
  instantBuild(): boolean {
    return this._gameConfig.instantBuild;
  }
  disableAlliances(): boolean {
    // customAllianceDuration === 0 disables alliances (the "custom alliances"
    // control at 0). The legacy boolean is still honored for older configs.
    return (
      this._gameConfig.customAllianceDuration === 0 ||
      (this._gameConfig.disableAlliances ?? false)
    );
  }
  isRandomSpawn(): boolean {
    return this._gameConfig.randomSpawn;
  }
  infiniteTroops(): boolean {
    return this._gameConfig.infiniteTroops;
  }
  donateTroops(): boolean {
    return this._gameConfig.donateTroops;
  }
  trainStationMaxRange(): number {
    return 110;
  }

  unitInfo(type: UnitType): UnitInfo {
    const cached = this.unitInfoCache.get(type);
    if (cached !== undefined) {
      return cached;
    }

    let info: UnitInfo;
    switch (type) {
      case UnitType.Warship:
        info = { maxHealth: 1000 };
        break;
      case UnitType.Shell:
        info = { damage: 250 };
        break;
      case UnitType.Port:
        info = {
          constructionDuration: this.instantBuild() ? 0 : 5 * 10,
          upgradable: true,
        };
        break;
      case UnitType.MissileSilo:
        info = {
          constructionDuration: this.instantBuild() ? 0 : 10 * 10,
          upgradable: true,
        };
        break;
      case UnitType.DefensePost:
        info = { constructionDuration: this.instantBuild() ? 0 : 5 * 10 };
        break;
      case UnitType.SAMLauncher:
        info = {
          constructionDuration: this.instantBuild()
            ? 0
            : SAM_CONSTRUCTION_TICKS,
          upgradable: true,
        };
        break;
      case UnitType.City:
      case UnitType.Factory:
        info = {
          constructionDuration: this.instantBuild() ? 0 : 2 * 10,
          upgradable: true,
        };
        break;
      case UnitType.Hospital:
      case UnitType.Bank:
        info = {
          constructionDuration: this.instantBuild() ? 0 : 3 * 10,
          upgradable: true,
        };
        break;
      case UnitType.Bunker:
      case UnitType.CoastalBattery:
        info = {
          constructionDuration: this.instantBuild() ? 0 : 5 * 10,
          upgradable: true,
        };
        break;
      case UnitType.Airbase:
        info = {
          constructionDuration: this.instantBuild() ? 0 : 10 * 10,
          upgradable: true,
        };
        break;
      case UnitType.CruiseMissile:
      case UnitType.NeutronBomb:
      case UnitType.ClusterBomb:
      case UnitType.Paratroopers:
      case UnitType.TransportShip:
      case UnitType.SAMMissile:
      case UnitType.AtomBomb:
      case UnitType.HydrogenBomb:
      case UnitType.MIRV:
      case UnitType.MIRVWarhead:
      case UnitType.TradeShip:
      case UnitType.Train:
      case UnitType.TacticalMissile:
      case UnitType.EMPBomb:
        info = {};
        break;
      default:
        assertNever(type);
    }

    if (info.constructionDuration !== undefined) {
      info.constructionDuration = this.blitzTime(info.constructionDuration);
    }
    this.unitInfoCache.set(type, info);
    return info;
  }

  private hasInfiniteTroopsFor(player: PlayerLike): boolean {
    if (this.infiniteTroops()) return true;
    return (
      (this._gameConfig.hostCheats?.infiniteTroops ?? false) &&
      player.isLobbyCreator()
    );
  }
  deletionMarkDuration(): Tick {
    return 30 * 10;
  }

  deleteUnitCooldown(): Tick {
    return 30 * 10;
  }
  allianceRequestDuration(): Tick {
    return 20 * 10;
  }
  allianceDuration(): Tick {
    // Host can set a custom alliance duration in minutes (1-15); 0 disables
    // alliances (see disableAlliances). Falls back to the 5 minute default.
    const m = this._gameConfig.customAllianceDuration;
    if (typeof m === "number" && m > 0) return m * 60 * 10;
    return 300 * 10; // 5 minutes.
  }

  percentageTilesOwnedToWin(elapsedGameSeconds: number): number {
    const base = PERCENT_TILES_OWNED_TO_WIN;
    const sd = this.overtimeConfig();
    if (!sd.enabled) {
      return base;
    }
    // Whole seconds only: elapsedGameSeconds is ticks/10 and can carry a
    // fractional part. The bar moves in WHOLE percentage points (one step
    // every 60/dropPercentPerMinute seconds), so the HUD shows exactly the
    // integer the sim checks — and integer math is trivially deterministic.
    const secondsPastStart =
      Math.floor(elapsedGameSeconds) - sd.startMinutes * 60;
    if (secondsPastStart <= 0) {
      return base;
    }
    return Math.max(
      0,
      base - Math.floor((secondsPastStart * sd.dropPercentPerMinute) / 60),
    );
  }
  armyLimitWarningThreshold(): number {
    return 0.8;
  }
  numSpawnPhaseTurns(): number {
    if (this._gameConfig.gameType === GameType.Singleplayer) {
      return 100;
    }
    if (this.isRandomSpawn()) {
      return 150;
    }
    return 200;
  }

  maxTroops(player: PlayerLike): number {
    return this.troopCap(player, true);
  }

  /** maxTroops without what cities add */
  maxTroopsWithoutCities(player: PlayerLike): number {
    return this.troopCap(player, false);
  }

  private troopCap(player: PlayerLike, withCities: boolean): number {
    const cityTroops = withCities
      ? player
          .units(UnitType.City)
          .filter((u) => !u.isUnderConstruction())
          .map((city) => city.level())
          .reduce((a, b) => a + b, 0) * this.cityTroopIncrease()
      : 0;
    const maxTroops =
      player.type() === PlayerType.Human && this.hasInfiniteTroopsFor(player)
        ? 1_000_000_000
        : 2 * (pow(player.numTilesOwned(), 0.6) * 1000 + 50000) + cityTroops;

    if (player.type() === PlayerType.Bot) {
      return maxTroops / 3;
    }

    if (player.type() === PlayerType.Human) {
      return maxTroops;
    }

    switch (this._gameConfig.difficulty) {
      case Difficulty.Easy:
        return maxTroops * 0.5;
      case Difficulty.Medium:
        return maxTroops * 0.75;
      case Difficulty.Hard:
        return maxTroops * 1; // Like humans
      case Difficulty.Impossible:
        return maxTroops * 1.25;
      default:
        assertNever(this._gameConfig.difficulty);
    }
  }

  troopIncreaseRate(player: PlayerLike): number {
    const max = this.maxTroops(player);

    let toAdd = 10 + pow(player.troops(), 0.73) / 4;

    const ratio = 1 - player.troops() / max;
    toAdd *= ratio;

    const hospitals = this.completedLevels(player, UnitType.Hospital);
    if (hospitals > 0) {
      toAdd *= 1 + this.hospitalRegenBonus(hospitals);
    }

    if (player.type() === PlayerType.Bot) {
      toAdd *= 0.5;
    }

    if (player.type() === PlayerType.Nation) {
      switch (this._gameConfig.difficulty) {
        case Difficulty.Easy:
          toAdd *= 0.9;
          break;
        case Difficulty.Medium:
          toAdd *= 0.95;
          break;
        case Difficulty.Hard:
          toAdd *= 1; // Like humans
          break;
        case Difficulty.Impossible:
          toAdd *= 1.05;
          break;
        default:
          assertNever(this._gameConfig.difficulty);
      }
    }

    if (this.isBlitz()) {
      toAdd *= MUTATOR_DEFAULTS.blitzIncomeMultiplier;
    }

    return Math.min(player.troops() + toAdd, max) - player.troops();
  }

  nukeMagnitudes(unitType: UnitType): NukeMagnitude {
    switch (unitType) {
      case UnitType.MIRVWarhead:
        return { inner: 12, outer: 18 };
      case UnitType.AtomBomb:
        return { inner: 12, outer: 30 };
      case UnitType.HydrogenBomb:
        return { inner: 80, outer: 100 };
      case UnitType.TacticalMissile:
        return { inner: 5, outer: 8 };
      case UnitType.EMPBomb:
        // Destroys nothing: outer is the radius of the electromagnetic pulse.
        return { inner: 0, outer: 50 };
      case UnitType.CruiseMissile:
        return { inner: 4, outer: 7 };
      case UnitType.NeutronBomb:
        return { inner: 35, outer: 50 };
      // The area the submunitions scatter over, not a single blast.
      case UnitType.ClusterBomb:
        return { inner: 22, outer: 30 };
    }
    throw new Error(`Unknown nuke type: ${unitType}`);
  }

  clusterSubmunitionMagnitude(): NukeMagnitude {
    return { inner: 4, outer: 8 };
  }

  warheadProfile(unitType: UnitType): WarheadProfile {
    switch (unitType) {
      case UnitType.CruiseMissile:
        return {
          destroysTerritory: false,
          destroysStructures: true,
          destroysMobileUnits: true,
          troopDeathMultiplier: 0.3,
          submunitions: 0,
        };
      case UnitType.NeutronBomb:
        return {
          destroysTerritory: false,
          destroysStructures: false,
          destroysMobileUnits: true,
          troopDeathMultiplier: 1.5,
          submunitions: 0,
        };
      case UnitType.ClusterBomb:
        return { ...NUCLEAR_WARHEAD, submunitions: 8 };
      default:
        return NUCLEAR_WARHEAD;
    }
  }

  /**
   * Extra ticks an EMP keeps a launcher (SAM, silo, coastal battery, airbase)
   * knocked out: every slot restarts its normal reload only this long after
   * the pulse.
   */
  empDisableExtraTicks(): Tick {
    return 20 * 10;
  }

  /** Share of a warship's max health an EMP pulse burns away (percent). */
  empWarshipDamagePercent(): number {
    return 40;
  }

  nukeAllianceBreakThreshold(): number {
    return 100;
  }

  samRange(level: number): number {
    // rational growth function (level 1 = 70, level 5 just above hydro range, asymptotically approaches 150)
    return this.maxSamRange() - 480 / (level + 5);
  }

  maxSamRange(): number {
    return 150;
  }

  structureMinDist(): number {
    return 15;
  }

  /** Max-health boost per veterancy level, as an integer percent of base max
   *  health. Integer-only to keep the engine deterministic (no float constants). */
  warshipVeterancyHealthBonus(): number {
    return 20;
  }

  allianceExtensionPromptOffset(): number {
    return 300; // 30 seconds before expiration
  }
}
