import { ANON_WORDS, anonWordName } from "@openfront/shared/AnonNames";
import { MAX_USERNAME_LENGTH } from "./validations/username";

// Trim rather than reject: a name stored before the cap would otherwise fail
// validation and block play.
export function clampUsername(name: string): string {
  return name.length > MAX_USERNAME_LENGTH
    ? name.slice(0, MAX_USERNAME_LENGTH).trim()
    : name;
}

// Whether `name` has the shape of one genAnonUsername() produces: "Anon" + a
// word from the fixed bank (+ a digit). Used to tell a placeholder name from
// one the player chose.
export function looksGenerated(name: string): boolean {
  const match = /^Anon([A-Za-z]+)\d?$/u.exec(name);
  return match !== null && ANON_WORDS.includes(match[1]);
}

/**
 * The name for join paths that can't reach the username field at all. Nothing
 * is stored from here: it is always a freshly generated Anon… name.
 */
export function fallbackPlayerName(): string {
  return genAnonUsername();
}

// A memorable anonymous username: "Anon" + animal (+ digit). Draws from the same
// word bank as the server-side anonymisation overlay, but keeps the "Anon" prefix
// that the overlay drops — here it tells the player their name is a placeholder.
// Client-side fallback for players who never set a name — no roster here, so it
// draws a random slot (best-effort-unique); the overlay is what guarantees
// uniqueness in-game.
//
// Rejection-sample a uniform slot in [0, bound) from the CSPRNG: drawing a raw
// uint32 and taking `% bound` would be very slightly biased (the top partial
// bucket), so we discard the unrepresentable tail first. The bias is cosmetically
// irrelevant here, but this keeps the draw provably uniform.
export function genAnonUsername(): string {
  const bound = ANON_WORDS.length * 10;
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  const buf = new Uint32Array(1);
  let rand: number;
  do {
    crypto.getRandomValues(buf);
    rand = buf[0] ?? 0;
  } while (rand >= limit);
  // The "Anon" prefix lives HERE, not in anonWordName: a player's handle
  // should say it is a placeholder, whereas the in-game anonymisation setting
  // makes everyone anonymous and gains nothing from repeating the word.
  return `Anon${anonWordName(rand % bound)}`;
}
