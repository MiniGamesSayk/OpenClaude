import { beforeEach, describe, expect, it } from "vitest";
import { UserSettings } from "../../src/client/UserSettings";

describe("UserSettings: synchronisation avec le compte", () => {
  beforeEach(() => localStorage.clear());

  it("ne synchronise ni les réglages d'appareil ni le reste du stockage", () => {
    localStorage.setItem("settings.emojis", "false");
    localStorage.setItem("settings.hudOpacity", "0.5");
    localStorage.setItem("settings.graphics", "{}");
    localStorage.setItem("settings.lowSpecMode", "true");
    localStorage.setItem("player_persistent_id", "secret");
    localStorage.setItem("username", "Zed");
    expect(UserSettings.syncedSnapshot()).toEqual({
      "settings.emojis": "false",
      "settings.hudOpacity": "0.5",
    });
  });

  it("applique des réglages du compte et ignore les clés non autorisées", () => {
    UserSettings.applySynced({
      "settings.hudOpacity": "0.25",
      "settings.graphics": "{}",
      player_persistent_id: "pirate",
      "settings.emojis": 12,
    });
    expect(localStorage.getItem("settings.hudOpacity")).toBe("0.25");
    expect(localStorage.getItem("settings.graphics")).toBeNull();
    expect(localStorage.getItem("player_persistent_id")).toBeNull();
    expect(localStorage.getItem("settings.emojis")).toBeNull();
  });
});
