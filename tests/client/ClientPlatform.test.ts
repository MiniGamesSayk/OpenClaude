import { afterEach, describe, expect, it } from "vitest";
import { clientPlatform } from "../../src/client/ClientPlatform";

describe("clientPlatform", () => {
  afterEach(() => {
    delete (window as { openfrontDesktop?: unknown }).openfrontDesktop;
  });

  it("is web by default", () => {
    expect(clientPlatform()).toBe("web");
  });

  it("is steam inside the desktop shell, even without a Steam bridge", () => {
    (window as { openfrontDesktop?: unknown }).openfrontDesktop = {};
    expect(clientPlatform()).toBe("steam");
  });
});
