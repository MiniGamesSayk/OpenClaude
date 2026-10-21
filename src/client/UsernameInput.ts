import { sanitizeClanTag } from "@openfront/shared/SharedUtil";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../client/Utils";
import { clampUsername, genAnonUsername } from "./PlayerName";
import {
  MAX_CLAN_TAG_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_CLAN_TAG_LENGTH,
  MIN_USERNAME_LENGTH,
  validateClanTag,
  validateUsername,
} from "./validations/username";

interface LangSelectorLike {
  currentLang?: string;
  translations?: Record<string, string>;
  defaultTranslations?: Record<string, string>;
}

const usernameKey: string = "username";
const clanTagKey: string = "clanTag";

// Shared box metrics for the name field.
const NAME_BOX =
  "min-w-0 flex-1 h-full max-h-[44px] rounded-lg bg-transparent px-2 sm:px-3";
// `line-height: normal` because that is what an <input> uses for its editor
// box. Any fixed leading drifts a pixel under some fonts.
const NAME_TEXT =
  "text-xl/[normal] sm:text-2xl/[normal] font-medium tracking-wider " +
  "[text-shadow:0_1px_2px_rgba(0,0,0,0.9)]";

/**
 * The player's name and optional clan tag. Both are free text, remembered in
 * this browser; there is no account behind them. A player who has never typed
 * a name gets a generated "Anon…" one.
 */
@customElement("username-input")
export class UsernameInput extends LitElement {
  private baseUsername: string = "";
  private clanTag: string = "";
  private _isValid: boolean = true;
  private _lastValidatedLang: string | null = null;

  @property({ type: String }) validationError: string = "";

  createRenderRoot() {
    // Disable shadow DOM to allow Tailwind classes to work
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadStoredUsername();
  }

  protected updated(): void {
    // Re-validate when translations become available or language changes,
    // since initial validation may run before translations are loaded.
    if (this.validationError) {
      const langSelector = document.querySelector<LangSelectorLike & Element>(
        "lang-selector",
      );
      const lang = langSelector?.currentLang;
      const hasTranslations =
        langSelector?.translations ?? langSelector?.defaultTranslations;
      if (hasTranslations && lang && lang !== this._lastValidatedLang) {
        this._lastValidatedLang = lang;
        this.validateAndStore();
      }
    }
  }

  /** The name this player will play under. */
  public getUsername(): string {
    return this.baseUsername.trim();
  }

  public getClanTag(): string | null {
    return this.clanTag.length >= MIN_CLAN_TAG_LENGTH &&
      this.clanTag.length <= MAX_CLAN_TAG_LENGTH &&
      validateClanTag(this.clanTag).isValid
      ? this.clanTag
      : null;
  }

  private loadStoredUsername() {
    const stored = localStorage.getItem(usernameKey);
    if (stored) {
      this.clanTag = localStorage.getItem(clanTagKey) ?? "";
    }
    // Reuse the stored name; an empty or missing one is the player having
    // never chosen, so mint a placeholder (and keep it, so it stays stable).
    this.baseUsername = stored?.trim()
      ? clampUsername(stored.trim())
      : genAnonUsername();
    this.validateAndStore();
  }

  render() {
    return html`
      <!-- The name field takes whatever the tag input leaves, so the row
           always fills the strip. -->
      <div class="flex items-center w-full h-full gap-1.5 sm:gap-2">
        <input
          type="text"
          id="clan-tag-input"
          .value=${this.clanTag}
          @input=${this.handleClanTagChange}
          placeholder=${translateText("username.tag")}
          minlength="${MIN_CLAN_TAG_LENGTH}"
          maxlength="${MAX_CLAN_TAG_LENGTH}"
          aria-label=${translateText("username.clan_label")}
          title=${translateText("username.clan_label")}
          class="shrink-0 h-full max-h-[44px] w-[5.5rem] rounded-lg bg-transparent px-2 text-base font-semibold uppercase text-white placeholder-white/45 transition-colors hover:bg-white/5 focus:bg-white/5 focus:outline-none focus:ring-2 focus:ring-malibu-blue/60"
        />
        <input
          type="text"
          .value=${this.baseUsername}
          @input=${this.handleUsernameChange}
          placeholder="${translateText("username.enter_username")}"
          minlength="${MIN_USERNAME_LENGTH}"
          maxlength="${MAX_USERNAME_LENGTH}"
          aria-label=${translateText("username.enter_username")}
          class="text-left text-white placeholder-white/50 transition-colors text-ellipsis hover:bg-white/5 focus:bg-white/5 focus:outline-none focus:ring-2 focus:ring-malibu-blue/60 ${NAME_BOX} ${NAME_TEXT}"
        />
      </div>
      ${this.validationError
        ? html`<div
            class="absolute top-full left-0 z-50 w-full mt-1 flex flex-col gap-1"
          >
            <div
              id="username-validation-error"
              class="w-full px-3 py-2 text-sm font-medium border border-red-500/50 rounded-lg bg-red-900/90 text-red-200 backdrop-blur-md shadow-lg"
            >
              ${this.validationError}
            </div>
          </div>`
        : null}
    `;
  }

  private handleClanTagChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const originalValue = input.value;
    const val = sanitizeClanTag(originalValue);
    // Only show toast if characters were actually removed (not just uppercased)
    if (originalValue.toUpperCase() !== val) {
      input.value = val;
      // Show toast when invalid characters are removed
      window.dispatchEvent(
        new CustomEvent("show-message", {
          detail: {
            message: translateText("username.tag_invalid_chars"),
            color: "red",
            duration: 2000,
          },
        }),
      );
    } else if (originalValue !== val) {
      // Just update the input without toast if only case changed
      input.value = val;
    }
    this.clanTag = val;
    this.validateAndStore();
  }

  private handleUsernameChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const originalValue = input.value;
    const val = originalValue.replace(/[[\]]/g, "");
    if (originalValue !== val) {
      input.value = val;
      // Show toast when brackets are removed
      window.dispatchEvent(
        new CustomEvent("show-message", {
          detail: {
            message: translateText("username.invalid_chars"),
            color: "red",
            duration: 2000,
          },
        }),
      );
    }
    this.baseUsername = val;
    this.validateAndStore();
  }

  private validateAndStore() {
    const trimmedBase = this.baseUsername.trim();

    const clanTagResult = validateClanTag(this.clanTag);
    if (!clanTagResult.isValid) {
      this._isValid = false;
      this.validationError = clanTagResult.error ?? "";
      this.emitValidity();
      return;
    }

    const result = validateUsername(trimmedBase);
    this._isValid = result.isValid;
    if (result.isValid) {
      localStorage.setItem(usernameKey, trimmedBase);
      localStorage.setItem(clanTagKey, this.getClanTag() ?? "");
      this.validationError = "";
    } else {
      this.validationError = result.error ?? "";
    }
    this.emitValidity();
  }

  // Broadcast play-eligibility so action buttons can disable themselves.
  private emitValidity() {
    window.dispatchEvent(
      new CustomEvent("username-validity-change", {
        detail: { isValid: this.canPlay() },
      }),
    );
  }

  // Play-eligibility: the name and tag are syntactically valid.
  public canPlay(): boolean {
    return this._isValid;
  }
}
