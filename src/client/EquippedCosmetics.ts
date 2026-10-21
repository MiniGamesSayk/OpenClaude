import { PlayerCosmetics, PlayerPattern } from "@openfront/shared/WireSchemas";
import { ResolvedCosmetic } from "./Cosmetics";

export type EquippedCosmeticType = "pattern" | "skin" | "crown" | "effect";

export type EquippedCosmetic = {
  type: EquippedCosmeticType;
  /** Catalog key, same format `resolveCosmetics` produces. */
  key: string;
  name: string;
  /** Catalog entry, or null when the catalog isn't loaded or dropped the item. */
  resolved: ResolvedCosmetic | null;
  /** Patterns only — taken from the player, so it renders without the catalog. */
  pattern: PlayerPattern | null;
  /** Skins and crowns only. */
  imageUrl: string | null;
};

function keyForEquippedPattern(pattern: PlayerPattern): string {
  return pattern.colorPalette
    ? `pattern:${pattern.name}:${pattern.colorPalette.name}`
    : `pattern:${pattern.name}`;
}

/**
 * The cosmetics a player has equipped, paired with the viewer's catalog so the
 * UI can draw each one. Flags are left out: the panel already shows the flag.
 */
export function equippedCosmetics(
  cosmetics: PlayerCosmetics,
  catalog: ResolvedCosmetic[],
): EquippedCosmetic[] {
  const byKey = new Map(catalog.map((r) => [r.key, r]));
  // the catalog keys effects by their map key, which need not equal the
  // effect's name, so match on effectType plus the name both sides carry
  const effectByName = new Map(
    catalog
      .filter((r) => r.type === "effect")
      .map((r) => [`${r.effectType}:${r.cosmetic?.name}`, r]),
  );
  const equipped: EquippedCosmetic[] = [];

  const add = (
    type: EquippedCosmeticType,
    key: string,
    name: string,
    pattern: PlayerPattern | null,
    imageUrl: string | null,
  ) => {
    const resolved = byKey.get(key) ?? null;
    equipped.push({
      type,
      key,
      name,
      resolved,
      pattern,
      imageUrl,
    });
  };

  if (cosmetics.pattern) {
    add(
      "pattern",
      keyForEquippedPattern(cosmetics.pattern),
      cosmetics.pattern.name,
      cosmetics.pattern,
      null,
    );
  }
  if (cosmetics.skin) {
    add(
      "skin",
      `skin:${cosmetics.skin.name}`,
      cosmetics.skin.name,
      null,
      cosmetics.skin.url,
    );
  }
  if (cosmetics.crown) {
    add(
      "crown",
      `crown:${cosmetics.crown.name}`,
      cosmetics.crown.name,
      null,
      cosmetics.crown.url,
    );
  }
  for (const effect of Object.values(cosmetics.effects ?? {})) {
    const resolved =
      effectByName.get(`${effect.effectType}:${effect.name}`) ?? null;
    add(
      "effect",
      resolved?.key ?? `effect:${effect.effectType}:${effect.name}`,
      effect.name,
      null,
      null,
    );
  }

  return equipped;
}
