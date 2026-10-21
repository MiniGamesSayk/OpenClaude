import { beforeEach, describe, expect, it } from "vitest";
import {
  hideMenuChrome,
  menuChromeIsTornDown,
  restoreMenuChrome,
} from "../src/client/MenuChrome";

beforeEach(() => {
  restoreMenuChrome();
});

describe("menuChromeIsTornDown", () => {
  it("is false until the chrome is hidden", () => {
    expect(menuChromeIsTornDown()).toBe(false);
  });

  it("is true after hiding, and stays true across a second hide", () => {
    hideMenuChrome();
    hideMenuChrome();
    expect(menuChromeIsTornDown()).toBe(true);
  });

  it("is false again after restoring", () => {
    hideMenuChrome();
    restoreMenuChrome();
    expect(menuChromeIsTornDown()).toBe(false);
  });
});
