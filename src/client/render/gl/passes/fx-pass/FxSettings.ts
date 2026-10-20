/**
 * Pure (no WebGL) helpers that turn the `settings.fx` slice into per-spawn
 * FX parameters. Kept out of the passes so they can be unit-tested.
 */

import {
  UT_ATOM_BOMB,
  UT_CLUSTER_BOMB,
  UT_CRUISE_MISSILE,
  UT_EMP_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV_WARHEAD,
  UT_NEUTRON_BOMB,
} from "../../../types";
import type { RenderSettings } from "../../RenderSettings";

/**
 * Visual explosion radius (shockwave / debris scatter — not the gameplay
 * damage radius) for a detonating unit type, or undefined for non-nukes.
 */
export function nukeExplosionRadius(
  fx: RenderSettings["fx"],
  unitType: string,
): number | undefined {
  switch (unitType) {
    case UT_ATOM_BOMB:
      return fx.nukeRadiusAtom;
    case UT_HYDROGEN_BOMB:
      return fx.nukeRadiusHydro;
    case UT_MIRV_WARHEAD:
      return fx.nukeRadiusMirv;
    // Tactical missiles scale the atom/MIRV visuals by their blast size.
    case UT_CRUISE_MISSILE:
      return fx.nukeRadiusMirv * 0.3;
    case UT_CLUSTER_BOMB:
      return fx.nukeRadiusAtom;
    case UT_NEUTRON_BOMB:
      return fx.nukeRadiusAtom * 1.5;
    case UT_EMP_BOMB:
      return fx.nukeRadiusAtom * 2;
    default:
      return undefined;
  }
}
