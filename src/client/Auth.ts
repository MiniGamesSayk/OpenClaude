import { generateCryptoRandomUUID } from "./Utils";

const PERSISTENT_ID_KEY = "player_persistent_id";

/**
 * Every player is anonymous: there is no account, session or token exchange.
 * The browser keeps one random persistent ID in localStorage and presents it
 * to the game server as its play token (the server accepts these in dev and
 * standalone mode, see src/server/jwt.ts). Nothing here touches the network,
 * so starting or joining a game never waits on an auth round trip.
 */

// WARNING: DO NOT EXPOSE THIS ID
export async function getPlayToken(): Promise<string> {
  return getPersistentID();
}

// WARNING: DO NOT EXPOSE THIS ID
export function getPersistentID(): string {
  try {
    const value = localStorage.getItem(PERSISTENT_ID_KEY);
    if (value) return value;
    const newID = generateCryptoRandomUUID();
    localStorage.setItem(PERSISTENT_ID_KEY, newID);
    return newID;
  } catch {
    // Storage blocked: fall back to an ID that lives as long as the page.
    sessionId ??= generateCryptoRandomUUID();
    return sessionId;
  }
}

let sessionId: string | null = null;
