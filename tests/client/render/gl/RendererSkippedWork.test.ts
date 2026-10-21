/**
 * GPURenderer skips per-tick / per-frame work whose result can't be seen:
 * the fallout bloom without fallout, point lights while the day/night
 * composite is off, and SAM-radius / unit ally updates when the friendly set
 * didn't change.
 *
 * The renderer is built without its GL-heavy constructor; only the fields the
 * method under test touches are wired, with spies standing in for the passes.
 */

import { describe, expect, it, vi } from "vitest";
import { GPURenderer } from "../../../../src/client/render/gl/Renderer";
import type {
  NameEntry,
  PlayerState,
  UnitState,
} from "../../../../src/client/render/types";

type Spies = Record<string, ReturnType<typeof vi.fn>>;

/** A pass whose every method is a spy. */
function anyPass(): Spies {
  return new Proxy({} as Spies, {
    get(target, prop: string) {
      return (target[prop] ??= vi.fn());
    },
  });
}

function makeRenderer(fields: Record<string, unknown>): GPURenderer {
  const r = Object.create(GPURenderer.prototype) as GPURenderer;
  Object.assign(r, fields);
  return r;
}

describe("fallout bloom", () => {
  const PASSES = [
    "spawnOverlayPass",
    "borderStampPass",
    "railroadPass",
    "unitPass",
    "samRadiusPass",
    "hillZonePass",
    "rangeCirclePass",
    "nukeTrajectoryPass",
    "crosshairPass",
    "structurePass",
    "structureLevelPass",
    "smallPlayerGlowPass",
    "barPass",
    "selectionBoxPass",
    "moveIndicatorPass",
    "nukeTelegraphPass",
    "trailPass",
    "spiralRibbonPass",
    "fxPass",
    "coordinateGridPass",
    "namePass",
    "worldTextPass",
  ];

  function drawOverlays(opts: {
    hasFallout: boolean;
    falloutBloom: boolean;
  }): ReturnType<typeof vi.fn> {
    const bloomDraw = vi.fn();
    const passes = Object.fromEntries(PASSES.map((p) => [p, anyPass()]));
    const r = makeRenderer({
      ...passes,
      gl: anyPass(),
      bloomPass: { draw: bloomDraw },
      territoryPass: { hasFallout: () => opts.hasFallout },
      nightCompositePass: { getAmbient: () => 1 },
      settings: {
        passEnabled: {
          borderStamp: true,
          railroad: true,
          unit: true,
          falloutBloom: opts.falloutBloom,
          structure: true,
          bar: true,
          trail: true,
          fx: true,
          name: true,
        },
      },
      selectedUnitIds: [],
      altView: false,
      gridView: false,
      frameTick: 7,
    });
    (
      r as unknown as {
        renderOverlays(cam: Float32Array, zoom: number): void;
      }
    ).renderOverlays(new Float32Array(9), 1);
    return bloomDraw;
  }

  it("draws only while some tile has fallout", () => {
    expect(
      drawOverlays({ hasFallout: true, falloutBloom: true }),
    ).toHaveBeenCalledTimes(1);
    expect(
      drawOverlays({ hasFallout: false, falloutBloom: true }),
    ).not.toHaveBeenCalled();
  });

  it("stays off when the pass is disabled, fallout or not", () => {
    expect(
      drawOverlays({ hasFallout: true, falloutBloom: false }),
    ).not.toHaveBeenCalled();
  });
});

describe("point lights", () => {
  function unitMap(): Map<number, UnitState> {
    return new Map([[1, { id: 1 } as UnitState]]);
  }

  function makeLitRenderer(lightingEnabled: boolean) {
    const pointLightPass = { updateLights: vi.fn() };
    const lightmapPass = { draw: vi.fn((..._args: unknown[]) => ({})) };
    const r = makeRenderer({
      lastUnits: new Map(),
      lastStructures: new Map(),
      lastUnitsAtMs: 0,
      frameTick: 0,
      pointLightsStale: true,
      unitPass: { setFrameTick: vi.fn(), updateUnits: vi.fn() },
      samRadiusPass: { setTick: vi.fn() },
      barPass: { updateBars: vi.fn() },
      heatManager: { decayHeat: vi.fn() },
      pointLightPass,
      lightmapPass,
      territoryPass: { hasFallout: () => false },
      nightCompositePass: { draw: vi.fn() },
      camera: { getMatrix: () => new Float32Array(9), zoom: 1 },
      canvas: { width: 64, height: 64 },
      sceneTarget: { fbo: {}, tex: {}, w: 64, h: 64 },
      gl: anyPass(),
      settings: { lighting: { enabled: lightingEnabled } },
      drawBaseLayer: vi.fn(),
      renderOverlays: vi.fn(),
    });
    const renderFrame = () =>
      (r as unknown as { renderFrame(): void }).renderFrame();
    return {
      r,
      settings: (r as any).settings,
      pointLightPass,
      lightmapPass,
      renderFrame,
    };
  }

  it("is not rebuilt per tick while lighting is off", () => {
    const { r, pointLightPass } = makeLitRenderer(false);
    for (let tick = 0; tick < 3; tick++) r.updateUnits(unitMap(), tick);
    expect(pointLightPass.updateLights).not.toHaveBeenCalled();
  });

  it("is rebuilt every tick while lighting is on", () => {
    const { r, pointLightPass } = makeLitRenderer(true);
    const units = unitMap();
    r.updateUnits(units, 1);
    r.updateUnits(units, 2);
    expect(pointLightPass.updateLights).toHaveBeenCalledTimes(2);
    expect(pointLightPass.updateLights.mock.calls[0][0]).toBe(units);
  });

  it("catches up from the last units on the first frame lighting turns on", () => {
    const { r, settings, pointLightPass, lightmapPass, renderFrame } =
      makeLitRenderer(false);
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1234);
    const units = unitMap();
    r.updateUnits(units, 1);
    nowSpy.mockRestore();

    // Lighting off: frames draw no lightmap and build no lights.
    renderFrame();
    expect(pointLightPass.updateLights).not.toHaveBeenCalled();
    expect(lightmapPass.draw).not.toHaveBeenCalled();

    // Switched on mid-game: lights are packed from the last tick's units
    // (with that tick's arrival time) before the lightmap draws, once.
    settings.lighting.enabled = true;
    renderFrame();
    renderFrame();
    expect(pointLightPass.updateLights).toHaveBeenCalledTimes(1);
    expect(pointLightPass.updateLights).toHaveBeenCalledWith(units, 1234);
    expect(lightmapPass.draw).toHaveBeenCalledTimes(2);
    expect(
      pointLightPass.updateLights.mock.invocationCallOrder[0],
    ).toBeLessThan(lightmapPass.draw.mock.invocationCallOrder[0]);
  });

  it("tells the lightmap whether any fallout needs lighting", () => {
    const { settings, lightmapPass, renderFrame, r } = makeLitRenderer(true);
    settings.lighting.enabled = true;
    (r as any).territoryPass = { hasFallout: () => true };
    renderFrame();
    expect(lightmapPass.draw.mock.calls[0][4]).toBe(true);
    (r as any).territoryPass = { hasFallout: () => false };
    renderFrame();
    expect(lightmapPass.draw.mock.calls[1][4]).toBe(false);
  });
});

describe("friendly set (SAM radius + unit pass)", () => {
  function playersWithAllies(allies: number[]): Map<number, PlayerState> {
    return new Map([[1, { allies } as unknown as PlayerState]]);
  }

  function makeNamesRenderer() {
    const samRadiusPass = { setAllies: vi.fn() };
    const unitPass = { setAllies: vi.fn() };
    const r = makeRenderer({
      namePass: { updateNames: vi.fn() },
      samRadiusPass,
      unitPass,
      localPlayerID: 1,
      playerTeams: new Map<number, string>(),
      friendlyOwners: new Set<number>(),
      friendlyOwnersApplied: false,
      friendlyScratch: new Set<number>(),
    });
    const update = (players: Map<number, PlayerState>) =>
      r.updateNames(new Map<string, NameEntry>(), players, false);
    return { r, samRadiusPass, unitPass, update };
  }

  it("hands the passes a set only when its membership changes", () => {
    const { samRadiusPass, unitPass, update } = makeNamesRenderer();

    update(playersWithAllies([2, 3]));
    update(playersWithAllies([3, 2])); // same members, other order
    update(playersWithAllies([2, 3]));
    expect(samRadiusPass.setAllies).toHaveBeenCalledTimes(1);
    expect(unitPass.setAllies).toHaveBeenCalledTimes(1);
    expect(Array.from(samRadiusPass.setAllies.mock.calls[0][0]).sort()).toEqual(
      [2, 3],
    );
    expect(unitPass.setAllies.mock.calls[0][0]).toBe(
      samRadiusPass.setAllies.mock.calls[0][0],
    );

    update(playersWithAllies([2]));
    expect(samRadiusPass.setAllies).toHaveBeenCalledTimes(2);
    expect(Array.from(samRadiusPass.setAllies.mock.calls[1][0])).toEqual([2]);
    // The first set was not mutated under the passes' feet.
    expect(Array.from(samRadiusPass.setAllies.mock.calls[0][0]).sort()).toEqual(
      [2, 3],
    );
  });

  it("sends the first (empty) set so the passes start from a known state", () => {
    const { samRadiusPass, update } = makeNamesRenderer();
    update(playersWithAllies([]));
    update(playersWithAllies([]));
    expect(samRadiusPass.setAllies).toHaveBeenCalledTimes(1);
    expect(samRadiusPass.setAllies.mock.calls[0][0].size).toBe(0);
  });

  it("includes teammates", () => {
    const { r, samRadiusPass, update } = makeNamesRenderer();
    (r as any).playerTeams = new Map([
      [1, "red"],
      [4, "red"],
      [5, "blue"],
    ]);
    update(playersWithAllies([2]));
    expect(Array.from(samRadiusPass.setAllies.mock.calls[0][0]).sort()).toEqual(
      [2, 4],
    );
  });
});

describe("skin tables and background color", () => {
  function makeSkinRenderer() {
    const texSubImage2D = vi.fn();
    const gl = {
      TEXTURE_2D: 1,
      TEXTURE0: 2,
      activeTexture: vi.fn(),
      bindTexture: vi.fn(),
      texSubImage2D,
    };
    const r = makeRenderer({
      gl,
      skinLayerCpu: new Uint8Array(4096),
      skinAnchorCpu: new Uint16Array(4096 * 2),
      skinLayerTex: {},
      skinAnchorTex: {},
      skinLayerDirty: false,
      skinAnchorDirty: false,
      skinAtlas: { getLayer: (url: string) => (url === "known" ? 3 : -1) },
    });
    const flush = () =>
      (r as unknown as { flushSkinTables(): void }).flushSkinTables();
    return { r, texSubImage2D, flush };
  }

  it("uploads the spawn anchors and skin layers once, not per player", () => {
    const { r, texSubImage2D, flush } = makeSkinRenderer();
    for (let id = 1; id <= 50; id++) {
      r.setPlayerSpawn(id, id * 2, id * 3);
      r.setPlayerSkin(id, "known");
    }
    expect(texSubImage2D).not.toHaveBeenCalled();

    flush();
    expect(texSubImage2D).toHaveBeenCalledTimes(2);
    flush();
    expect(texSubImage2D).toHaveBeenCalledTimes(2);

    const anchors = (r as any).skinAnchorCpu as Uint16Array;
    expect([anchors[2 * 7], anchors[2 * 7 + 1]]).toEqual([14, 21]);
    expect((r as any).skinLayerCpu[7]).toBe(4); // layer + 1

    // A skin the atlas doesn't know is dropped without touching the texture.
    r.setPlayerSkin(8, "unknown");
    flush();
    expect(texSubImage2D).toHaveBeenCalledTimes(2);
  });

  it("parses the background color once per value", () => {
    const settings = { terrain: { backgroundColor: "#102030" } };
    const r = makeRenderer({
      settings,
      backgroundHex: null,
      backgroundParsed: [60, 60, 60],
    });
    const bg = () =>
      (
        r as unknown as {
          backgroundRgb(): readonly [number, number, number];
        }
      ).backgroundRgb();

    const first = bg();
    expect(first).toEqual([16, 32, 48]);
    expect(bg()).toBe(first); // cached, not re-parsed

    settings.terrain.backgroundColor = "#ffffff";
    expect(bg()).toEqual([255, 255, 255]);

    settings.terrain.backgroundColor = "not a color";
    expect(bg()).toEqual([60, 60, 60]);
  });
});
