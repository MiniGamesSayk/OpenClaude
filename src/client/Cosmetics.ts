import { assetUrl } from "@openfront/shared/AssetUrls";
import {
  ColorPalette,
  Cosmetics,
  CosmeticsSchema,
  Crown,
  Effect,
  findEffectForSlot,
  Flag,
  Pattern,
  Skin,
} from "@openfront/shared/CosmeticSchemas";
import {
  PlayerCosmeticRefs,
  PlayerCosmetics,
  PlayerEffect,
  PlayerPattern,
} from "@openfront/shared/WireSchemas";
import { UserSettings } from "./UserSettings";
import { translateText } from "./Utils";

/**
 * Every cosmetic is free: the catalog is a static file bundled with the game
 * (resources/cosmetics/cosmetics.json, also read by the game server), and
 * every entry in it can be worn by anyone. There is no ownership, price or
 * purchase flow.
 */

let __cosmetics: Promise<Cosmetics | null> | null = null;
let __cosmeticsCache: Cosmetics | null = null;

/**
 * Synchronous accessor for the most recently resolved cosmetics. Returns null
 * before the first successful `fetchCosmetics()` call. Useful when a code path
 * cannot await (e.g. WebGL per-frame sync).
 */
export function getCachedCosmetics(): Cosmetics | null {
  return __cosmeticsCache;
}

/**
 * Resolve the local player's selected skin from UserSettings + cached
 * cosmetics. Returns null if no skin is selected, cosmetics aren't loaded,
 * or the saved skin no longer exists.
 */
export function getLocalSelectedSkin(): { name: string; url: string } | null {
  const skinName = new UserSettings().getSelectedSkinName();
  if (!skinName) return null;
  const skin = __cosmeticsCache?.skins?.[skinName];
  if (!skin) return null;
  return { name: skin.name, url: skin.url };
}

export async function fetchCosmetics(): Promise<Cosmetics | null> {
  if (__cosmetics !== null) {
    return __cosmetics;
  }
  const request = (async () => {
    try {
      // A chunk of its own: only the screens and joins that need the catalog
      // pay for it.
      const { default: bundled } =
        await import("resources/cosmetics/cosmetics.json");
      const result = CosmeticsSchema.safeParse(bundled);
      if (!result.success) {
        console.error(`Invalid cosmetics: ${result.error.message}`);
        return null;
      }
      __cosmeticsCache = result.data;
      return result.data;
    } catch (error) {
      console.warn("Error loading cosmetics:", error);
      return null;
    }
  })();
  __cosmetics = request;
  void request.then((result) => {
    if (result === null && __cosmetics === request) {
      __cosmetics = null;
    }
  });
  return request;
}

/** Warms the catalog so a later join or screen answers from memory. */
export function prewarmCosmetics(): Promise<void> {
  return fetchCosmetics().then(
    () => undefined,
    () => undefined,
  );
}

export async function resolveFlagUrl(
  flagRef: string,
): Promise<string | undefined> {
  if (flagRef.startsWith("flag:")) {
    const key = flagRef.slice("flag:".length);
    const cosmetics = await fetchCosmetics();
    const flagData = cosmetics?.flags?.[key];
    return flagData?.url;
  }
  if (flagRef.startsWith("country:")) {
    const code = flagRef.slice("country:".length);
    return assetUrl(`flags/${code}.svg`);
  }
  return undefined;
}

export type ResolvedCosmetic = {
  type: "pattern" | "skin" | "flag" | "crown" | "effect";
  cosmetic: Pattern | Skin | Flag | Crown | Effect | null;
  colorPalette: ColorPalette | null;
  /** Unique key for selection/identity, e.g. "pattern:hearts:red" or "skin:mountain" */
  key: string;
  /** For effects only: the effectType (also the catalog's outer key). */
  effectType?: string;
};

/**
 * Resolves all cosmetics into a flat display-ready list with resolved color
 * palettes.
 */
export function resolveCosmetics(
  cosmetics: Cosmetics | null,
): ResolvedCosmetic[] {
  if (!cosmetics) return [];
  const result: ResolvedCosmetic[] = [];

  // Default pattern
  result.push({
    type: "pattern",
    cosmetic: null,
    colorPalette: null,
    key: "pattern:default",
  });

  // Patterns × color palettes. Archived palettes are no longer offered.
  for (const [patternKey, pattern] of Object.entries(cosmetics.patterns)) {
    const colorPalettes = [
      ...(pattern.colorPalettes ?? []).filter((cp) => !cp.isArchived),
      null,
    ];
    for (const cp of colorPalettes) {
      const resolvedPalette = cp
        ? (cosmetics.colorPalettes?.[cp.name] ?? null)
        : null;
      const key = cp
        ? `pattern:${patternKey}:${cp.name}`
        : `pattern:${patternKey}`;
      result.push({
        type: "pattern",
        cosmetic: pattern,
        colorPalette: resolvedPalette,
        key,
      });
    }
  }

  for (const [flagKey, flag] of Object.entries(cosmetics.flags)) {
    result.push({
      type: "flag",
      cosmetic: flag,
      colorPalette: null,
      key: `flag:${flagKey}`,
    });
  }

  for (const [crownKey, crown] of Object.entries(cosmetics.crowns ?? {})) {
    result.push({
      type: "crown",
      cosmetic: crown,
      colorPalette: null,
      key: `crown:${crownKey}`,
    });
  }

  // Skins (image-based territory cosmetics). No separate "default" entry —
  // the pattern default doubles as "no skin": selecting it clears both.
  for (const [skinKey, skin] of Object.entries(cosmetics.skins ?? {})) {
    result.push({
      type: "skin",
      cosmetic: skin,
      colorPalette: null,
      key: `skin:${skinKey}`,
    });
  }

  // Effects (boat-trail wakes, etc.) — a cosmetic category like skins/flags.
  // Catalog is nested: effects[effectType][effectName]. We carry effectType (the
  // outer key, which each effect also stores) on the resolved item.
  for (const [effectType, byName] of Object.entries(cosmetics.effects ?? {})) {
    for (const [effectKey, effect] of Object.entries(byName ?? {})) {
      result.push({
        type: "effect",
        cosmetic: effect,
        colorPalette: null,
        key: `effect:${effectType}:${effectKey}`,
        effectType,
      });
    }
  }

  return result;
}

/**
 * Groups resolved cosmetics so that colour-palette variants of the same pattern
 * collapse into a single entry. Returns an array of groups in first-seen order
 */
export function groupCosmeticVariants(
  items: ResolvedCosmetic[],
): ResolvedCosmetic[][] {
  const groups: ResolvedCosmetic[][] = [];
  const patternGroupByName = new Map<string, number>();
  for (const item of items) {
    if (item.type === "pattern" && item.cosmetic !== null) {
      const name = item.cosmetic.name;
      const existing = patternGroupByName.get(name);
      if (existing !== undefined) {
        groups[existing].push(item);
        continue;
      }
      patternGroupByName.set(name, groups.length);
    }
    groups.push([item]);
  }
  return groups;
}

export function resolvedToPlayerPattern(
  resolved: ResolvedCosmetic,
): PlayerPattern | null {
  if (resolved.type !== "pattern") return null;
  const c = resolved.cosmetic;
  if (c === null) return null;
  return {
    name: c.name,
    patternData: (c as Pattern).pattern,
    colorPalette: resolved.colorPalette ?? undefined,
  };
}

/**
 * The saved selections as the refs a join sends to the server. A selection
 * the catalog no longer lists is dropped (and forgotten); anything else is
 * worn as chosen -- nothing needs to be owned.
 */
export async function getPlayerCosmeticsRefs(): Promise<PlayerCosmeticRefs> {
  const userSettings = new UserSettings();
  const cosmetics = await fetchCosmetics();
  const pattern: PlayerPattern | null =
    userSettings.getSelectedPatternName(cosmetics);

  let flag = userSettings.getFlag();
  if (flag?.startsWith("flag:")) {
    const key = flag.slice("flag:".length);
    // Only clear if cosmetics loaded successfully but the key is missing
    if (cosmetics && !cosmetics.flags?.[key]) {
      flag = null;
      userSettings.clearFlag();
    }
  }

  let skinName = userSettings.getSelectedSkinName() ?? undefined;
  if (skinName && !cosmetics?.skins?.[skinName]) {
    // Cosmetics loaded but the saved skin no longer exists.
    // Skins share the pattern selection key (see UserSettings).
    if (cosmetics) userSettings.setSelectedPatternName(undefined);
    skinName = undefined;
  }

  let crownName = userSettings.getSelectedCrownName() ?? undefined;
  if (crownName && !cosmetics?.crowns?.[crownName]) {
    if (cosmetics) userSettings.setSelectedCrownName(undefined);
    crownName = undefined;
  }

  // Effects: a per-slot map (slot -> effect name). A slot is the effectType for
  // trails and the nukeType for nuke explosions (see effectTypeForSlot). Drop any
  // entry whose effect no longer exists or doesn't fit the slot.
  const selectedEffects = userSettings.getSelectedEffects();
  const effects: Record<string, string> = {};
  for (const [slot, name] of Object.entries(selectedEffects)) {
    const effect = findEffectForSlot(cosmetics, slot, name);
    if (!effect) {
      if (cosmetics) {
        userSettings.setSelectedEffectName(slot, undefined);
      }
      continue;
    }
    effects[slot] = name;
  }

  return {
    flag: flag ?? undefined,
    patternName: pattern?.name ?? undefined,
    patternColorPaletteName: pattern?.colorPalette?.name ?? undefined,
    skinName,
    crownName,
    effects: Object.keys(effects).length > 0 ? effects : undefined,
  };
}

export async function getPlayerCosmetics(): Promise<PlayerCosmetics> {
  const refs = await getPlayerCosmeticsRefs();
  const cosmetics = await fetchCosmetics();

  const result: PlayerCosmetics = {};

  if (refs.flag) {
    result.flag = await resolveFlagUrl(refs.flag);
  }

  const devPattern = new UserSettings().getDevOnlyPattern();

  if (devPattern) {
    result.pattern = {
      name: devPattern.name,
      patternData: devPattern.patternData,
      colorPalette: devPattern.colorPalette,
    };
  } else if (refs.patternName && cosmetics) {
    const pattern = cosmetics.patterns[refs.patternName];

    if (pattern) {
      result.pattern = {
        name: refs.patternName,
        patternData: pattern.pattern,
        colorPalette: refs.patternColorPaletteName
          ? cosmetics.colorPalettes?.[refs.patternColorPaletteName]
          : undefined,
      };
    }
  }

  if (refs.skinName && cosmetics) {
    const skin = cosmetics.skins?.[refs.skinName];
    if (skin) {
      result.skin = { name: refs.skinName, url: skin.url };
    }
  }

  const devCrown = new UserSettings().getDevOnlyCrown();

  if (devCrown) {
    result.crown = { name: "dev_crown", url: devCrown };
  } else if (refs.crownName && cosmetics) {
    const crown = cosmetics.crowns?.[refs.crownName];
    if (crown) {
      result.crown = { name: refs.crownName, url: crown.url };
    }
  }

  if (refs.effects && cosmetics) {
    const effects: Record<string, PlayerEffect> = {};
    for (const [slot, name] of Object.entries(refs.effects)) {
      const effect = findEffectForSlot(cosmetics, slot, name);
      if (effect) {
        effects[slot] = { name: effect.name, effectType: effect.effectType };
      }
    }
    if (Object.keys(effects).length > 0) result.effects = effects;
  }

  return result;
}

export function translateCosmetic(prefix: string, name: string): string {
  const translation = translateText(`${prefix}.${name}`);
  if (translation.startsWith(prefix)) {
    return name
      .split("_")
      .filter((word) => word.length > 0)
      .map((word) => word[0].toUpperCase() + word.substring(1))
      .join(" ");
  }
  return translation;
}
