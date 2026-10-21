import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string) => key,
}));

import { UsernameInput } from "../../src/client/UsernameInput";

async function mount(): Promise<UsernameInput> {
  if (!customElements.get("username-input")) {
    customElements.define("username-input", UsernameInput);
  }
  const el = document.createElement("username-input") as UsernameInput;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("username-input", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("starts anonymous: a generated Anon name, playable immediately", async () => {
    const el = await mount();
    expect(el.getUsername()).toMatch(/^Anon/);
    expect(el.canPlay()).toBe(true);
    expect(el.getClanTag()).toBeNull();
  });

  it("remembers the name and clan tag it was given", async () => {
    const el = await mount();
    const [tag, name] = Array.from(el.querySelectorAll("input"));
    name.value = "Alice";
    name.dispatchEvent(new Event("input"));
    tag.value = "abc";
    tag.dispatchEvent(new Event("input"));
    expect(el.getUsername()).toBe("Alice");
    expect(el.getClanTag()).toBe("ABC");
    document.body.innerHTML = "";

    const again = await mount();
    expect(again.getUsername()).toBe("Alice");
    expect(again.getClanTag()).toBe("ABC");
  });

  it("blocks play on an invalid name and says why", async () => {
    const el = await mount();
    const name = el.querySelectorAll("input")[1];
    name.value = "a";
    name.dispatchEvent(new Event("input"));
    await el.updateComplete;
    expect(el.canPlay()).toBe(false);
    expect(el.querySelector("#username-validation-error")).not.toBeNull();
  });

  it("has no sign-in, verified-name or clan-picker controls", async () => {
    const el = await mount();
    expect(el.querySelectorAll("button")).toHaveLength(0);
    expect(el.querySelector("[aria-haspopup]")).toBeNull();
  });
});
