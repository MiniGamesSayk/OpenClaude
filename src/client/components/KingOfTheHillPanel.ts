import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";
import { GameView } from "../view";

/**
 * The King of the Hill readout: who controls the hill and how long each
 * leading side has held it, against the hold time needed to win. Before the
 * hill opens it shows the countdown instead. Embedded by game-right-sidebar so
 * it stacks under the game timer, like the overtime and doomsday-clock
 * panels. Hidden when the mutator is off and after a winner.
 */
@customElement("king-of-the-hill-panel")
export class KingOfTheHillPanel extends LitElement {
  @property({ attribute: false }) game!: GameView;
  @property({ attribute: false }) hasWinner = false;
  // Bumped by the parent each tick so the readout advances every second.
  @property({ attribute: false }) refreshKey = 0;

  // Light DOM so Tailwind classes apply and it stacks in the parent's flex.
  createRenderRoot() {
    return this;
  }

  // A side is a player id in FFA and a team name in team games.
  private sideName(side: string, isTeamGame: boolean): string {
    if (isTeamGame) {
      const key = `team_colors.${side.toLowerCase()}`;
      const translated = translateText(key);
      return translated !== key ? translated : side;
    }
    const player = this.game.playerViews().find((p) => p.id() === side);
    return player?.displayName() ?? side;
  }

  private isMine(side: string, isTeamGame: boolean): boolean {
    const me = this.game.myPlayer();
    if (me === null) return false;
    return isTeamGame ? me.team() === side : me.id() === side;
  }

  render() {
    const hill = this.game?.kingOfTheHill() ?? null;
    const visible = hill !== null && !this.hasWinner;
    this.style.display = visible ? "block" : "none";
    if (!visible || hill === null) return html``;

    const panel =
      "w-fit flex flex-col gap-1.5 py-2 px-4 bg-gray-800/92 backdrop-blur-sm shadow-xs rounded-bl-lg text-white text-sm";
    const title = html`<span class="font-bold tracking-wide text-yellow-300">
      ${translateText("king_of_the_hill.title")}
    </span>`;

    if (hill.opensInSeconds > 0) {
      return html`
        <div class="${panel}">
          ${title}
          <div class="text-xs text-gray-300">
            ${translateText("king_of_the_hill.opens_in", {
              time: formatSeconds(hill.opensInSeconds),
            })}
          </div>
        </div>
      `;
    }

    const holder =
      hill.holder === null
        ? translateText("king_of_the_hill.nobody")
        : this.sideName(hill.holder, hill.isTeamGame);
    return html`
      <div class="${panel}">
        <div class="flex items-center justify-between gap-3">
          ${title}
          <span class="text-yellow-200 font-bold">
            ${translateText("king_of_the_hill.to_win", {
              time: formatSeconds(hill.secondsToWin),
            })}
          </span>
        </div>
        <div class="text-xs text-gray-300">
          ${translateText("king_of_the_hill.holder", { name: holder })}
        </div>
        ${hill.leaders.map((leader) => {
          const pct = Math.min(100, (leader.seconds / hill.secondsToWin) * 100);
          const barClass = this.isMine(leader.side, hill.isTeamGame)
            ? "bg-green-400"
            : "bg-red-400";
          return html`
            <div class="flex items-center gap-2 text-xs">
              <span class="w-24 truncate">
                ${this.sideName(leader.side, hill.isTeamGame)}
              </span>
              <div
                class="relative h-2 w-28 overflow-hidden rounded bg-gray-600/60"
              >
                <div
                  class="absolute inset-y-0 left-0 ${barClass}"
                  style="width:${pct}%"
                ></div>
              </div>
              <span class="tabular-nums">${formatSeconds(leader.seconds)}</span>
            </div>
          `;
        })}
      </div>
    `;
  }
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
