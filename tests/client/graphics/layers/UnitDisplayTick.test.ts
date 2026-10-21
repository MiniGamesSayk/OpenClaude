/**
 * UnitDisplay.tick() feeds a hotbar that is not drawn while the player is
 * dead, still spawning or every unit is disabled: it must not ask the worker
 * for buildables then, and it asks for one answer at a time otherwise.
 */

vi.mock("lit", () => ({
  html: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  LitElement: class extends EventTarget {
    requestUpdate() {}
  },
}));

vi.mock("lit/decorators.js", () => ({
  customElement: () => (clazz: unknown) => clazz,
  state: () => () => {},
  property: () => () => {},
  query: () => () => {},
}));

import { BuildMenus, UnitType } from "@openfront/engine-api/game/GameTypes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnitDisplay } from "../../../../src/client/hud/layers/UnitDisplay";

describe("UnitDisplay tick", () => {
  let ud: UnitDisplay;
  let requestUpdate: ReturnType<typeof vi.fn>;
  let answers: ((b: unknown[]) => void)[];
  let alive: boolean;
  let spawning: boolean;

  const player = {
    isAlive: () => alive,
    buildables: vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          answers.push(resolve);
        }),
    ),
    totalUnitLevelsFor: vi.fn((types: readonly UnitType[], out: number[]) => {
      out.length = types.length;
      types.forEach((t, i) => (out[i] = types.length - i));
      return out;
    }),
  };

  beforeEach(() => {
    answers = [];
    alive = true;
    spawning = false;
    player.buildables.mockClear();
    player.totalUnitLevelsFor.mockClear();
    ud = new UnitDisplay();
    requestUpdate = vi.fn();
    ud.requestUpdate = requestUpdate as never;
    ud.game = {
      myPlayer: () => player,
      inSpawnPhase: () => spawning,
    } as never;
  });

  it("asks for buildables once per answer, not once per tick", async () => {
    ud.tick();
    ud.tick();
    ud.tick();
    expect(player.buildables).toHaveBeenCalledTimes(1);
    expect(player.buildables).toHaveBeenCalledWith(undefined, BuildMenus.types);

    answers[0]([]);
    await Promise.resolve();
    await Promise.resolve();
    ud.tick();
    expect(player.buildables).toHaveBeenCalledTimes(2);
  });

  it("does no work while the player is dead, spawning or has everything disabled", () => {
    alive = false;
    ud.tick();
    alive = true;
    spawning = true;
    ud.tick();
    spawning = false;
    (ud as unknown as { allDisabled: boolean }).allDisabled = true;
    ud.tick();

    expect(player.buildables).not.toHaveBeenCalled();
    expect(player.totalUnitLevelsFor).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("counts every unit total in one pass and renders them in order", () => {
    ud.tick();
    expect(player.totalUnitLevelsFor).toHaveBeenCalledTimes(1);
    const [types] = player.totalUnitLevelsFor.mock.calls[0];
    expect(types).toEqual([
      UnitType.City,
      UnitType.MissileSilo,
      UnitType.Port,
      UnitType.DefensePost,
      UnitType.SAMLauncher,
      UnitType.Factory,
      UnitType.Warship,
      UnitType.Hospital,
      UnitType.Bank,
      UnitType.Bunker,
      UnitType.CoastalBattery,
      UnitType.Airbase,
    ]);
    const fields = ud as unknown as Record<string, number>;
    expect(fields._cities).toBe(12);
    expect(fields._missileSilo).toBe(11);
    expect(fields._port).toBe(10);
    expect(fields._defensePost).toBe(9);
    expect(fields._samLauncher).toBe(8);
    expect(fields._factories).toBe(7);
    expect(fields._warships).toBe(6);
    const extra = (ud as unknown as { _extraLevels: Map<UnitType, number> })
      ._extraLevels;
    expect(extra.get(UnitType.Hospital)).toBe(5);
    expect(extra.get(UnitType.Airbase)).toBe(1);
  });

  it("refreshes the hotbar when the first buildables arrive", async () => {
    ud.tick();
    requestUpdate.mockClear();
    answers[0]([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });
});
