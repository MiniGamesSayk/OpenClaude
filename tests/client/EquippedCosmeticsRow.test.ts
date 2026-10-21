import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResolvedCosmetic } from "../../src/client/Cosmetics";

const { fetchCosmetics, resolveCosmetics } = vi.hoisted(() => ({
  fetchCosmetics: vi.fn(async () => null),
  resolveCosmetics: vi.fn((): ResolvedCosmetic[] => []),
}));

vi.mock("../../src/client/Cosmetics", () => ({
  fetchCosmetics,
  resolveCosmetics,
  translateCosmetic: (_prefix: string, name: string) => name,
}));
vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));

import { EquippedCosmeticsRow } from "../../src/client/components/EquippedCosmeticsRow";

function crownEntry(): ResolvedCosmetic {
  return {
    type: "crown",
    cosmetic: { name: "gold", rarity: "legendary" } as never,
    colorPalette: null,
    key: "crown:gold",
  };
}

async function renderRow(): Promise<EquippedCosmeticsRow> {
  if (!customElements.get("equipped-cosmetics-row")) {
    customElements.define("equipped-cosmetics-row", EquippedCosmeticsRow);
  }
  const el = document.createElement(
    "equipped-cosmetics-row",
  ) as EquippedCosmeticsRow;
  el.cosmetics = { crown: { name: "gold", url: "/crown.png" } };
  document.body.appendChild(el);
  await el.updateComplete;
  // Second settle: the catalog and account load after the first render.
  await Promise.resolve();
  await el.updateComplete;
  return el;
}

describe("equipped-cosmetics-row", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    resolveCosmetics.mockReturnValue([]);
  });

  it("renders nothing for a player with no cosmetics", async () => {
    const el = await renderRow();
    el.cosmetics = {};
    await el.updateComplete;

    expect(el.querySelector("[title]")).toBeNull();
    // The host must not keep taking up a flex gap once it has no tiles.
    expect(el.hasAttribute("hidden")).toBe(true);
  });

  it("unhides the host once the player has cosmetics", async () => {
    resolveCosmetics.mockReturnValue([crownEntry()]);
    const el = await renderRow();

    expect(el.hasAttribute("hidden")).toBe(false);
  });

  it("shows a plain tile per equipped item, with no store link", async () => {
    resolveCosmetics.mockReturnValue([crownEntry()]);
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    const el = await renderRow();
    expect(el.querySelector("button")).toBeNull();
    expect(el.querySelectorAll("[title]").length).toBeGreaterThan(0);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
