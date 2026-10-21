import type { RenderSettings } from "./RenderSettings";

/**
 * Low-spec mode, for weak machines: render at 1x device pixels, cap the
 * frame rate and drop the purely cosmetic passes. Turned on by the user
 * setting, or automatically when the device looks weak (software WebGL, few
 * cores, little memory). The simulation is untouched.
 */
let lowSpec = false;

/** Frames per second the renderer is capped to in low-spec mode. */
export const LOW_SPEC_MAX_FPS = 30;

export function lowSpecMode(): boolean {
  return lowSpec;
}

export function setLowSpecMode(on: boolean): void {
  lowSpec = on;
}

// Renderer strings reported by software WebGL backends (same as initGL).
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software/i;

/**
 * Whether this device looks too weak for the full renderer: WebGL2 only in
 * software (no GPU acceleration), at most 2 CPU cores, or at most 2 GB of
 * memory. Probes a throwaway canvas, so no context is locked.
 */
export function detectWeakDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };
  if ((nav.hardwareConcurrency ?? 8) <= 2) return true;
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 2) return true;
  const canvas = document.createElement("canvas");
  const accel = canvas.getContext("webgl2", {
    failIfMajorPerformanceCaveat: true,
  });
  if (accel === null) return true;
  const info = accel.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(
    info
      ? accel.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : accel.getParameter(accel.RENDERER),
  );
  accel.getExtension("WEBGL_lose_context")?.loseContext();
  return SOFTWARE_RENDERER.test(renderer);
}

/** Turn off the purely cosmetic, costly passes. */
export function applyLowSpecSettings(settings: RenderSettings): void {
  settings.passEnabled.fx = false;
  settings.passEnabled.falloutBloom = false;
  settings.passEnabled.falloutLight = false;
  settings.smallPlayerGlow.strength = 0;
  settings.lighting.ambient = 1;
  settings.lighting.enabled = false;
}
