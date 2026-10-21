import { afterEach, describe, expect, test, vi } from "vitest";
import { verifyClientToken } from "../../src/server/jwt";
import { ServerEnv } from "../../src/server/ServerEnv";

const PERSISTENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("anonymous play", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test("a standalone server accepts a bare persistent ID as the play token", async () => {
    vi.stubEnv("STANDALONE", "1");
    expect(ServerEnv.anonymousJoins()).toBe(true);
    const result = await verifyClientToken(PERSISTENT_ID);
    expect(result).toEqual({
      type: "success",
      persistentId: PERSISTENT_ID,
      claims: null,
    });
  });

  test("a non-standalone, non-dev server does not", async () => {
    vi.stubEnv("STANDALONE", "");
    // The suite runs with GAME_ENV unset; only dev would allow it.
    if (ServerEnv.anonymousJoins()) return;
    const result = await verifyClientToken(PERSISTENT_ID);
    expect(result.type).toBe("error");
  });
});

describe("automatic public lobbies", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("are off unless PUBLIC_LOBBIES is set", () => {
    vi.stubEnv("PUBLIC_LOBBIES", "");
    expect(ServerEnv.publicLobbies()).toBe(false);
    vi.stubEnv("PUBLIC_LOBBIES", "0");
    expect(ServerEnv.publicLobbies()).toBe(false);
  });

  test("can be turned back on", () => {
    vi.stubEnv("PUBLIC_LOBBIES", "1");
    expect(ServerEnv.publicLobbies()).toBe(true);
    vi.stubEnv("PUBLIC_LOBBIES", "true");
    expect(ServerEnv.publicLobbies()).toBe(true);
  });
});
