import { AllPlayersStats, Winner } from "@openfront/engine-api/Schemas";
import { logger } from "./Logger";

// Compte sayk.fr (connexion Discord). Le service `auth` pose un cookie de
// session partagé par les sous-domaines ; ici le serveur de jeu le montre au
// service (réseau Docker, clé du jeu) pour savoir qui rejoint une partie, puis
// lui envoie le bilan de fin de partie. Sans SAYK_AUTH_URL tout est inactif et
// le jeu reste anonyme.

const log = logger.child({ component: "SaykAccount" });

const COOKIE_RE = /(?:^|;\s*)sayk_session=([0-9a-f]{64})(?:;|$)/;
const TIMEOUT_MS = 1500;

export interface SaykAccountConfig {
  url: string;
  key: string;
}

export interface SaykAccountService {
  /** Compte pour l'en-tête `Cookie` d'une connexion, null si anonyme ou injoignable. */
  resolve(cookieHeader: string | undefined): Promise<string | null>;
  /** Ajoute (`add`) ou garde le meilleur (`max`) de compteurs; n'attend pas, n'échoue jamais. */
  report(
    userId: string,
    add: Record<string, number>,
    max: Record<string, number>,
  ): void;
}

export function createSaykAccountService(
  config: SaykAccountConfig | null,
): SaykAccountService | null {
  if (!config || config.url === "" || config.key === "") return null;
  const base = config.url.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
  };
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  return {
    async resolve(cookieHeader) {
      const token =
        cookieHeader === undefined
          ? undefined
          : COOKIE_RE.exec(cookieHeader)?.[1];
      if (token === undefined) return null;
      try {
        const res = await post("/internal/resolve", { token });
        if (!res.ok) return null;
        const data = (await res.json()) as { user: { id?: unknown } | null };
        return typeof data.user?.id === "string" ? data.user.id : null;
      } catch (err) {
        log.warn(`resolve failed: ${err}`);
        return null;
      }
    },
    report(userId, add, max) {
      post("/internal/stats", { userId, add, max }).then(
        (res) => {
          if (!res.ok) log.warn(`stats rejected: ${res.status}`);
        },
        (err) => log.warn(`stats failed: ${err}`),
      );
    },
  };
}

let service: SaykAccountService | null | undefined;

/** Service configuré par l'environnement (SAYK_AUTH_URL, SAYK_AUTH_KEY), créé une fois. */
export function saykAccounts(): SaykAccountService | null {
  service ??= createSaykAccountService({
    url: process.env.SAYK_AUTH_URL ?? "",
    key: process.env.SAYK_AUTH_KEY ?? "",
  });
  return service;
}

export interface SaykPlayer {
  clientID: string;
  userId: string;
}

export interface SaykResult {
  userId: string;
  add: Record<string, number>;
  max: Record<string, number>;
}

function winnerIDs(winner: Winner | undefined): Set<string> {
  if (winner === undefined) return new Set();
  // ["player", id, ...ids], ["team", name, ...ids] ou ["nation", name, ...ids]
  return new Set(winner.slice(winner[0] === "player" ? 1 : 2));
}

/**
 * Bilan de chaque joueur lié à un compte. La victoire n'est comptée que si le
 * vainqueur a été confirmé (au moins deux IP d'accord, ou rejeu du serveur) :
 * un vote isolé ne suffit pas à s'attribuer une victoire.
 */
export function saykResults(
  players: readonly SaykPlayer[],
  winner: { winner?: Winner; allPlayersStats: AllPlayersStats } | null,
  statsAgreed: boolean,
  durationMs: number,
): SaykResult[] {
  const winners = statsAgreed ? winnerIDs(winner?.winner) : new Set<string>();
  const seconds = Number.isFinite(durationMs)
    ? Math.max(0, Math.round(durationMs / 1000))
    : 0;
  return players.map((p) => ({
    userId: p.userId,
    add: {
      games: 1,
      wins: winners.has(p.clientID) ? 1 : 0,
      secondsPlayed: seconds,
    },
    max: {},
  }));
}
