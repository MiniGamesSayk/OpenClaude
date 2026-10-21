import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./components/IOSAddToHomeScreenBanner";
import type { HostLobbyModal } from "./HostLobbyModal";
import type { JoinLobbyModal } from "./JoinLobbyModal";
import { whenModalLoaded } from "./LazyModals";
import type { SinglePlayerModal } from "./SinglePlayerModal";
import { UsernameInput } from "./UsernameInput";
import { getGamesPlayed, translateText } from "./Utils";

const PRIMARY_ACTION =
  "bg-malibu-blue hover:bg-aquarius active:bg-malibu-blue/80 hover:scale-y-105 hover:scale-x-[1.01]";
const SECONDARY_ACTION =
  "bg-surface hover:brightness-[1.08] active:brightness-[0.95] hover:scale-105 hover:shadow-[var(--shadow-action-card-hover)]";
const DISABLED = "opacity-50 cursor-not-allowed pointer-events-none";
/** Tutorial card: the panel's gold, dark text for contrast. */
const TUTORIAL_ACTION =
  "bg-cyber-yellow hover:bg-yellow-300 active:bg-cyber-yellow/80 !text-gray-900 hover:scale-y-105 hover:scale-x-[1.01]";

/** The Tutorial card shows beside Solo until the player has played this many games. */
const TUTORIAL_CARD_MAX_GAMES = 5;

/**
 * The homepage's game entry points: Solo, Tutorial, Create lobby and Join by
 * code. There is no public lobby list -- games exist only because a player
 * made one.
 */
@customElement("game-mode-selector")
export class GameModeSelector extends LitElement {
  @state() private inputValid: boolean = true;

  createRenderRoot() {
    return this;
  }

  // Silent backstop; the buttons are already disabled while input is invalid.
  private validateUsername(): boolean {
    const usernameInput = document.querySelector(
      "username-input",
    ) as UsernameInput | null;
    return usernameInput ? usernameInput.canPlay() : true;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(
      "username-validity-change",
      this.handleValidityChange,
    );
    // Pick up the current value in case username-input validated before us.
    const usernameInput = document.querySelector(
      "username-input",
    ) as UsernameInput | null;
    if (usernameInput) {
      this.inputValid = usernameInput.canPlay();
    }
  }

  disconnectedCallback() {
    window.removeEventListener(
      "username-validity-change",
      this.handleValidityChange,
    );
    super.disconnectedCallback();
  }

  private handleValidityChange = (e: Event) => {
    this.inputValid = (e as CustomEvent).detail?.isValid ?? true;
  };

  render() {
    return html`
      <div class="flex flex-col gap-4 w-full px-4 pb-4 mx-auto sm:px-0 sm:pb-0">
        <ios-add-to-home-screen-banner
          class="[&:empty]:hidden"
        ></ios-add-to-home-screen-banner>

        <div class="flex gap-4 h-14">
          <div class="flex-[2]">
            ${this.renderActionCard(
              translateText("main.solo"),
              this.openSinglePlayerModal,
              PRIMARY_ACTION,
            )}
          </div>
          ${getGamesPlayed() < TUTORIAL_CARD_MAX_GAMES
            ? html`<div class="flex-1">
                ${this.renderActionCard(
                  translateText("main.tutorial"),
                  this.startTutorial,
                  TUTORIAL_ACTION,
                )}
              </div>`
            : nothing}
        </div>
        <div class="grid grid-cols-2 gap-4 h-14">
          ${this.renderActionCard(
            translateText("main.create"),
            this.openHostLobby,
            SECONDARY_ACTION,
          )}
          ${this.renderActionCard(
            translateText("main.join"),
            this.openJoinLobby,
            SECONDARY_ACTION,
          )}
        </div>
      </div>
    `;
  }

  private openSinglePlayerModal = () => {
    if (!this.validateUsername()) return;
    whenModalLoaded("single-player-modal", () =>
      (
        document.querySelector("single-player-modal") as SinglePlayerModal
      )?.open(),
    );
  };

  // Handled in Main, which also serves the help page's tutorial button.
  private startTutorial = () => {
    if (!this.validateUsername()) return;
    document.dispatchEvent(new CustomEvent("start-tutorial"));
  };

  private openHostLobby = () => {
    if (!this.validateUsername()) return;
    whenModalLoaded("host-lobby-modal", () =>
      (document.querySelector("host-lobby-modal") as HostLobbyModal)?.open(),
    );
  };

  private openJoinLobby = () => {
    if (!this.validateUsername()) return;
    whenModalLoaded("join-lobby-modal", () =>
      (document.querySelector("join-lobby-modal") as JoinLobbyModal)?.open(),
    );
  };

  private renderActionCard(
    title: string,
    onClick: () => void,
    bgClass: string,
  ) {
    return html`
      <button
        @click=${onClick}
        ?disabled=${!this.inputValid}
        class="relative flex items-center justify-center w-full h-full rounded-lg ${bgClass} transition-all duration-200 text-sm lg:text-base font-medium text-white uppercase tracking-wider text-center ${!this
          .inputValid
          ? DISABLED
          : ""}"
      >
        ${title}
      </button>
    `;
  }
}
