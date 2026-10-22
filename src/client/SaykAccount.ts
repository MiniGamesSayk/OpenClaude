import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { looksGenerated } from "./PlayerName";
import { translateText } from "./Utils";
import { UserSettings } from "./UserSettings";
import { UsernameInput } from "./UsernameInput";
import { validateUsername } from "./validations/username";

/**
 * Compte sayk.fr (connexion Discord). Le service `api.sayk.fr` pose un cookie
 * de session partagé par les sous-domaines; connecté, les réglages, le pseudo
 * et le tag de clan suivent le joueur d'un appareil à l'autre, et ses
 * statistiques (écrites par le serveur de jeu) s'affichent ici. Hors de
 * sayk.fr (développement local) ou si le service ne répond pas, le jeu reste
 * anonyme et tout se passe dans le localStorage, comme avant.
 */

const GAME = "openclaude";
const USERNAME_KEY = "username";
const CLAN_TAG_KEY = "clanTag";
const PUSH_DELAY_MS = 800;
const POLL_MS = 10_000;
/** Plafond du service pour les réglages (16 ko) moins une marge. */
const MAX_SETTINGS_BYTES = 15_000;

interface SaykUser {
  id: string;
  name: string;
  avatar: string | null;
}

export function saykApiBase(): string | null {
  return /(^|\.)sayk\.fr$/.test(location.hostname)
    ? "https://api.sayk.fr"
    : null;
}

function loginUrl(): string | null {
  const base = saykApiBase();
  if (base === null) return null;
  const back = new URL(location.href);
  back.searchParams.delete("login_error");
  return `${base}/auth/login?return=${encodeURIComponent(back.toString())}`;
}

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${saykApiBase()}${path}`, {
    credentials: "include",
    signal: AbortSignal.timeout(6000),
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function storedProfile(): { username: string; clanTag: string } {
  try {
    return {
      username: localStorage.getItem(USERNAME_KEY) ?? "",
      clanTag: localStorage.getItem(CLAN_TAG_KEY) ?? "",
    };
  } catch {
    return { username: "", clanTag: "" };
  }
}

@customElement("sayk-account")
export class SaykAccount extends LitElement {
  @state() private user: SaykUser | null = null;
  @state() private stats: Record<string, number> | null = null;
  @state() private loginError = false;

  private ready = false;
  private lastPushed = { settings: "", profile: "" };
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  createRenderRoot() {
    // Pas de shadow DOM: les classes Tailwind s'appliquent.
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    if (saykApiBase() === null) return;
    const params = new URLSearchParams(location.search);
    if (params.has("login_error")) {
      this.loginError = true;
      params.delete("login_error");
      const qs = params.toString();
      history.replaceState(
        null,
        "",
        location.pathname + (qs ? `?${qs}` : "") + location.hash,
      );
    }
    void this.init();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.pollTimer);
    clearTimeout(this.pushTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private async init() {
    try {
      const res = await call("/api/me");
      if (!res.ok) return;
      const { user } = (await res.json()) as { user: SaykUser | null };
      if (!user) return;
      this.user = user;
      await this.pull(user);
    } catch {
      // Service injoignable: on reste anonyme.
    }
  }

  private async pull(user: SaykUser) {
    const res = await call(`/api/games/${GAME}/data`);
    if (!res.ok) return;
    const data = (await res.json()) as {
      settings: Record<string, unknown> | null;
      profile: { username?: unknown; clanTag?: unknown } | null;
      stats: Record<string, number>;
    };

    if (data.settings) UserSettings.applySynced(data.settings);

    const local = storedProfile();
    let { username, clanTag } = local;
    if (data.profile) {
      if (typeof data.profile.username === "string") {
        username = data.profile.username;
      }
      if (typeof data.profile.clanTag === "string") {
        clanTag = data.profile.clanTag;
      }
    } else if (username === "" || looksGenerated(username)) {
      // Première connexion: le pseudo Discord remplace le pseudo généré.
      const candidate = user.name.trim().slice(0, 20);
      if (validateUsername(candidate).isValid) username = candidate;
    }
    if (username !== local.username || clanTag !== local.clanTag) {
      try {
        localStorage.setItem(USERNAME_KEY, username);
        localStorage.setItem(CLAN_TAG_KEY, clanTag);
      } catch {
        // Pseudo non mémorisé localement.
      }
      document
        .querySelector<UsernameInput>("username-input")
        ?.reloadFromStorage();
    }

    // Ce qu'on vient d'appliquer est l'état du serveur: on ne renvoie que ce qu'il n'avait pas.
    this.lastPushed.settings = data.settings
      ? JSON.stringify(UserSettings.syncedSnapshot())
      : "";
    this.lastPushed.profile = data.profile
      ? JSON.stringify(storedProfile())
      : "";
    this.stats = data.stats;
    this.ready = true;
    this.pollTimer = setInterval(() => this.schedulePush(), POLL_MS);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.schedulePush();
  }

  // Les réglages sont écrits un à un dans le localStorage, sans événement
  // global: on compare régulièrement l'instantané au dernier envoi.
  private onVisibility = () => {
    if (document.hidden) void this.push();
  };

  private schedulePush() {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.push(), PUSH_DELAY_MS);
  }

  private async push() {
    if (!this.ready) return;
    const settings = JSON.stringify(UserSettings.syncedSnapshot());
    const profile = JSON.stringify(storedProfile());
    const jobs: [string, string][] = [];
    if (
      settings !== this.lastPushed.settings &&
      settings.length <= MAX_SETTINGS_BYTES
    ) {
      jobs.push(["settings", settings]);
    }
    if (profile !== this.lastPushed.profile) jobs.push(["profile", profile]);
    for (const [kind, body] of jobs) {
      this.lastPushed[kind as "settings" | "profile"] = body;
      try {
        const res = await call(`/api/games/${GAME}/${kind}`, {
          method: "PUT",
          // keepalive: l'envoi survit à la fermeture de l'onglet.
          keepalive: body.length < 60_000,
          body,
        });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        // Échec: on réessaiera au prochain passage.
        this.lastPushed[kind as "settings" | "profile"] = "";
      }
    }
  }

  private async logout() {
    this.ready = false;
    clearInterval(this.pollTimer);
    this.user = null;
    this.stats = null;
    await call("/auth/logout", { method: "POST" }).catch(() => undefined);
  }

  render() {
    const href = loginUrl();
    if (href === null) return nothing;
    if (this.user === null) {
      return html`<div
        class="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm text-white/70"
      >
        <a
          href=${href}
          class="rounded-lg bg-[#5865f2] px-3 py-1.5 font-semibold text-white no-underline hover:brightness-110"
          >${translateText("sayk_account.login")}</a
        >
        <span
          >${this.loginError
            ? translateText("sayk_account.error")
            : translateText("sayk_account.hint")}</span
        >
      </div>`;
    }
    const s = this.stats;
    return html`<div
      class="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm text-white/70"
    >
      <span
        >${translateText("sayk_account.logged_as", {
          name: this.user.name,
        })}</span
      >
      <button
        type="button"
        class="underline hover:text-white"
        @click=${() => void this.logout()}
      >
        ${translateText("sayk_account.logout")}
      </button>
      ${s && (s.games ?? 0) > 0
        ? html`<span
            >${translateText("sayk_account.stats", {
              games: s.games ?? 0,
              wins: s.wins ?? 0,
            })}</span
          >`
        : nothing}
    </div>`;
  }
}
