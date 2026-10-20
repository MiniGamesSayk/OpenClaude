/**
 * Canonical unit type string constants.
 *
 * These match the strings the upstream game sends in UnitEventUpdate.unitType.
 * Use these instead of raw string literals to prevent typos and enable
 * find-all-references.
 */

// ---------------------------------------------------------------------------
// Individual unit type constants
// ---------------------------------------------------------------------------

// Mobile units
export const UT_TRANSPORT = "Transport" as const;
export const UT_TRADE_SHIP = "Trade Ship" as const;
export const UT_WARSHIP = "Warship" as const;
export const UT_ATOM_BOMB = "Atom Bomb" as const;
export const UT_HYDROGEN_BOMB = "Hydrogen Bomb" as const;
export const UT_MIRV = "MIRV" as const;
export const UT_SAM_MISSILE = "SAMMissile" as const;
export const UT_SHELL = "Shell" as const;
export const UT_MIRV_WARHEAD = "MIRV Warhead" as const;
export const UT_TRAIN = "Train" as const;
export const UT_CRUISE_MISSILE = "Cruise Missile" as const;
export const UT_NEUTRON_BOMB = "Neutron Bomb" as const;
export const UT_EMP_BOMB = "EMP Bomb" as const;
export const UT_CLUSTER_BOMB = "Cluster Bomb" as const;
export const UT_PARATROOPERS = "Paratroopers" as const;

// Structures
export const UT_CITY = "City" as const;
export const UT_PORT = "Port" as const;
export const UT_FACTORY = "Factory" as const;
export const UT_DEFENSE_POST = "Defense Post" as const;
export const UT_SAM_LAUNCHER = "SAM Launcher" as const;
export const UT_MISSILE_SILO = "Missile Silo" as const;
export const UT_HOSPITAL = "Hospital" as const;
export const UT_BANK = "Bank" as const;
export const UT_BUNKER = "Bunker" as const;
export const UT_COASTAL_BATTERY = "Coastal Battery" as const;
export const UT_AIRBASE = "Airbase" as const;

// ---------------------------------------------------------------------------
// Derived sets
// ---------------------------------------------------------------------------

export const STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  UT_CITY,
  UT_PORT,
  UT_FACTORY,
  UT_DEFENSE_POST,
  UT_SAM_LAUNCHER,
  UT_MISSILE_SILO,
  UT_HOSPITAL,
  UT_BANK,
  UT_BUNKER,
  UT_COASTAL_BATTERY,
  UT_AIRBASE,
]);

/** Silo-launched non-nuclear warheads (each with its own impact effect). */
export const TACTICAL_MISSILE_TYPES: ReadonlySet<string> = new Set([
  UT_CRUISE_MISSILE,
  UT_NEUTRON_BOMB,
  UT_EMP_BOMB,
  UT_CLUSTER_BOMB,
]);

export const NUKE_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
]);

/** Nuke types whose rendered position is interpolated lastPos→pos each render
 *  frame (UnitPass). Their trails stamp only up to lastPos so the tail never
 *  leads the smoothly-moving missile. */
export const SMOOTHED_NUKE_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  ...TACTICAL_MISSILE_TYPES,
  UT_PARATROOPERS,
]);

/** Units that leave a trail on the map (TrailManager). */
export const TRAIL_TYPES: ReadonlySet<string> = new Set([
  UT_TRANSPORT,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  ...TACTICAL_MISSILE_TYPES,
  UT_PARATROOPERS,
]);

/** Blast radii (in tiles) matching upstream DefaultConfig.nukeMagnitudes(). */
export const NUKE_MAGNITUDES: Readonly<
  Record<string, { inner: number; outer: number }>
> = {
  [UT_ATOM_BOMB]: { inner: 12, outer: 30 },
  [UT_HYDROGEN_BOMB]: { inner: 80, outer: 100 },
  [UT_MIRV_WARHEAD]: { inner: 12, outer: 18 },
  [UT_CRUISE_MISSILE]: { inner: 4, outer: 7 },
  [UT_NEUTRON_BOMB]: { inner: 35, outer: 50 },
  [UT_EMP_BOMB]: { inner: 50, outer: 65 },
  [UT_CLUSTER_BOMB]: { inner: 22, outer: 30 },
};

// ---------------------------------------------------------------------------
// Ordered lists (atlas column order — used by GPU passes + header)
// ---------------------------------------------------------------------------

/**
 * Structure types in icon-atlas column order (resources/atlases/icon-atlas.png,
 * one 64px cell each). Shared by StructurePass and StructureLevelPass; the
 * per-column background shape lives in structure.frag.glsl shapeSDF.
 */
export const STRUCTURE_ATLAS_ORDER = [
  UT_CITY,
  UT_PORT,
  UT_FACTORY,
  UT_DEFENSE_POST,
  UT_SAM_LAUNCHER,
  UT_MISSILE_SILO,
  UT_HOSPITAL,
  UT_BANK,
  UT_BUNKER,
  UT_COASTAL_BATTERY,
  UT_AIRBASE,
] as const;

/** All unit type strings in the canonical order used by RendererConfig.unitTypes. */
export const ALL_UNIT_TYPES = [
  UT_TRANSPORT,
  UT_TRADE_SHIP,
  UT_WARSHIP,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_MIRV_WARHEAD,
  UT_CITY,
  UT_PORT,
  UT_FACTORY,
  UT_DEFENSE_POST,
  UT_SAM_LAUNCHER,
  UT_MISSILE_SILO,
  UT_TRAIN,
  UT_CRUISE_MISSILE,
  UT_NEUTRON_BOMB,
  UT_EMP_BOMB,
  UT_CLUSTER_BOMB,
  UT_PARATROOPERS,
  UT_HOSPITAL,
  UT_BANK,
  UT_BUNKER,
  UT_COASTAL_BATTERY,
  UT_AIRBASE,
] as const;
