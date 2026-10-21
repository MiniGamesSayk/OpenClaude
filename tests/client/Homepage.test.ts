import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@openfront/shared/AssetUrls", () => ({
  assetUrl: (path: string) => path,
}));
vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string) => key,
  getGamesPlayed: () => 10,
}));
vi.mock("../../src/client/LazyModals", () => ({
  whenModalLoaded: (_tag: string, open: () => void) => open(),
  loadModal: async () => {},
}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import { GameModeSelector } from "../../src/client/GameModeSelector";
import "../../src/client/UsernameInput";
import { PlayPage } from "../../src/client/components/PlayPage";

describe("homepage game entry points", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function mountSelector() {
    if (!customElements.get("game-mode-selector")) {
      customElements.define("game-mode-selector", GameModeSelector);
    }
    const el = document.createElement("game-mode-selector") as GameModeSelector;
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  }

  it("offers solo, create lobby and join by code, and nothing else", async () => {
    const el = await mountSelector();
    const labels = Array.from(el.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toEqual(["main.solo", "main.create", "main.join"]);
  });

  it("shows no public lobby list, ranked entry or upcoming-games heading", async () => {
    const el = await mountSelector();
    const text = el.textContent ?? "";
    for (const forbidden of [
      "ranked",
      "public_lobby",
      "upcoming",
      "matchmaking",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("opens the host-private-lobby modal when Create is clicked, with no login", async () => {
    const open = vi.fn();
    const host = document.createElement("host-lobby-modal") as HTMLElement & {
      open: () => void;
    };
    host.open = open;
    document.body.appendChild(host);

    const el = await mountSelector();
    const create = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "main.create",
    )!;
    create.click();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens the join-by-code modal when Join is clicked", async () => {
    const open = vi.fn();
    const join = document.createElement("join-lobby-modal") as HTMLElement & {
      open: () => void;
    };
    join.open = open;
    document.body.appendChild(join);

    const el = await mountSelector();
    const button = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "main.join",
    )!;
    button.click();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("the play page has no account menu, store or stream promos", async () => {
    if (!customElements.get("play-page")) {
      customElements.define("play-page", PlayPage);
    }
    const el = document.createElement("play-page") as PlayPage;
    document.body.appendChild(el);
    await el.updateComplete;
    for (const tag of [
      "nav-account-menu",
      "streaming-now",
      "steam-wishlist",
      "token-login",
      "rewards-modal",
      "homepage-promos",
    ]) {
      expect(el.querySelector(tag), tag).toBeNull();
    }
    expect(el.querySelector("game-mode-selector")).not.toBeNull();
    expect(el.querySelector("username-input")).not.toBeNull();
  });
});
