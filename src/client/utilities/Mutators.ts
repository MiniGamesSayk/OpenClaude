import { MutatorsConfig } from "@openfront/engine-api/Schemas";
import type { ToggleOptionConfig } from "../components/GameConfigSettings";

/** Every mutator switch, in the order the lobby lists them. */
export const MUTATOR_KEYS = [
  "meteorShower",
  "blitz",
  "kingOfTheHill",
  "underdog",
] as const satisfies readonly (keyof MutatorsConfig)[];
export type MutatorKey = (typeof MUTATOR_KEYS)[number];

/** Lobby toggle label (and summary) key per mutator. */
export const MUTATOR_LABEL_KEYS: Record<MutatorKey, string> = {
  meteorShower: "game_settings.meteor_shower",
  blitz: "game_settings.blitz",
  kingOfTheHill: "game_settings.king_of_the_hill",
  underdog: "game_settings.underdog",
};

/** Hover explanation per mutator toggle. */
export const MUTATOR_DESC_KEYS: Record<MutatorKey, string> = {
  meteorShower: "game_settings.meteor_shower_desc",
  blitz: "game_settings.blitz_desc",
  kingOfTheHill: "game_settings.king_of_the_hill_desc",
  underdog: "game_settings.underdog_desc",
};

/** The lobby toggles for the mutators, checked per `mutators`. */
export function mutatorToggles(
  mutators: MutatorsConfig | undefined,
): ToggleOptionConfig[] {
  return MUTATOR_KEYS.map((key) => ({
    labelKey: MUTATOR_LABEL_KEYS[key],
    checked: mutators?.[key] ?? false,
    descKey: MUTATOR_DESC_KEYS[key],
  }));
}

/** The mutator a lobby toggle label belongs to, if any. */
export function mutatorForLabel(labelKey: string): MutatorKey | undefined {
  return MUTATOR_KEYS.find((key) => MUTATOR_LABEL_KEYS[key] === labelKey);
}

/** The mutators that are switched on, in lobby order. */
export function activeMutators(
  mutators: MutatorsConfig | undefined,
): MutatorKey[] {
  return MUTATOR_KEYS.filter((key) => mutators?.[key] === true);
}

/**
 * The full on/off set to send in a GameConfig. Every key is explicit so a
 * host patch can switch a mutator back off (undefined would be dropped by
 * JSON.stringify and the server would keep the old value).
 */
export function mutatorsConfig(
  mutators: MutatorsConfig | undefined,
): Required<MutatorsConfig> {
  return {
    meteorShower: mutators?.meteorShower ?? false,
    blitz: mutators?.blitz ?? false,
    kingOfTheHill: mutators?.kingOfTheHill ?? false,
    underdog: mutators?.underdog ?? false,
  };
}
