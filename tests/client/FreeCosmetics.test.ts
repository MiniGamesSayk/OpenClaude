import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string) => key,
}));

import {
  fetchCosmetics,
  getPlayerCosmeticsRefs,
  resolveCosmetics,
} from "../../src/client/Cosmetics";
import { UserSettings } from "../../src/client/UserSettings";

describe("free cosmetics", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loads the bundled catalog without any network or account", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const catalog = await fetchCosmetics();
    expect(catalog).not.toBeNull();
    expect(Object.keys(catalog!.flags).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("lists every catalog entry, with no price or ownership attached", async () => {
    const catalog = await fetchCosmetics();
    const items = resolveCosmetics(catalog);
    const flags = items.filter((r) => r.type === "flag");
    expect(flags).toHaveLength(Object.keys(catalog!.flags).length);
    for (const item of items) {
      expect(item).not.toHaveProperty("relationship");
    }
  });

  it("sends a selected catalog flag in the join refs, no login needed", async () => {
    const catalog = await fetchCosmetics();
    const name = Object.keys(catalog!.flags)[0];
    new UserSettings().setFlag(`flag:${name}`);
    const refs = await getPlayerCosmeticsRefs();
    expect(refs.flag).toBe(`flag:${name}`);
    expect(refs).not.toHaveProperty("verified");
  });

  it("forgets a selected flag the catalog no longer lists", async () => {
    new UserSettings().setFlag("flag:does_not_exist");
    const refs = await getPlayerCosmeticsRefs();
    expect(refs.flag).toBeUndefined();
  });
});
