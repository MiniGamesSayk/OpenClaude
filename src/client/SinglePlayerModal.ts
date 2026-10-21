import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { MutatorsConfig, TeamCountConfig } from "@openfront/engine-api/Schemas";
import { DoomsdayClockSpeed } from "@openfront/engine-lib/game/DoomsdayClock";
import { generateID } from "@openfront/shared/SharedUtil";
import { PlayerCosmetics } from "@openfront/shared/WireSchemas";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "../client/Utils";
import "./components/baseComponents/Button";
import "./components/baseComponents/Modal";
import { BaseModal } from "./components/BaseModal";
import "./components/GameConfigSettings";
import "./components/ToggleInputCard";
import { modalHeader } from "./components/ui/ModalHeader";
import { getPlayerCosmetics, prewarmCosmetics } from "./Cosmetics";
import { GameStartingModal } from "./GameStartingModal";
import { showInGameAlert } from "./InGameModal";
import { JoinLobbyEvent } from "./Main";
import { fallbackPlayerName } from "./PlayerName";
import { UsernameInput } from "./UsernameInput";
import { UserSettings } from "./UserSettings";
import {
  getBotsForCompactMap,
  getNationsForCompactMap,
  getRandomMapType,
  getUpdatedDisabledUnits,
  parseBoundedFloatFromInput,
  parseBoundedIntegerFromInput,
  preventDisallowedKeys,
  sliderToNationsConfig,
  toOptionalNumber,
} from "./utilities/GameConfigHelpers";
import {
  activeMutators,
  mutatorForLabel,
  mutatorsConfig,
  mutatorToggles,
} from "./utilities/Mutators";

import { terrainMapFileLoader } from "./TerrainMapFileLoader";

const DEFAULT_OPTIONS = {
  selectedMap: GameMapType.World,
  selectedDifficulty: Difficulty.Easy,
  bots: 400,
  infiniteGold: false,
  infiniteTroops: false,
  compactMap: false,
  maxTimer: false,
  maxTimerValue: undefined as number | undefined,
  instantBuild: false,
  randomSpawn: false,
  useRandomMap: false,
  gameMode: GameMode.FFA,
  teamCount: 2 as TeamCountConfig,
  goldMultiplier: false,
  goldMultiplierValue: undefined as number | undefined,
  startingGold: false,
  startingGoldValue: undefined as number | undefined,
  disabledUnits: [] as UnitType[],
  customAlliances: false,
  customAllianceMinutes: undefined as number | undefined,
  waterNukes: false,
  doomsdayClock: false,
  doomsdayClockSpeed: "normal" as DoomsdayClockSpeed,
  overtime: false,
  overtimeStartMinutes: undefined as number | undefined,
  mutators: {} as MutatorsConfig,
} as const;

@customElement("single-player-modal")
export class SinglePlayerModal extends BaseModal {
  protected routerName = "single-player";

  @state() private selectedMap: GameMapType = DEFAULT_OPTIONS.selectedMap;
  @state() private selectedDifficulty: Difficulty =
    DEFAULT_OPTIONS.selectedDifficulty;
  @state() private nations: number = 0;
  @state() private defaultNationCount: number = 0;
  @state() private bots: number = DEFAULT_OPTIONS.bots;
  @state() private infiniteGold: boolean = DEFAULT_OPTIONS.infiniteGold;
  @state() private infiniteTroops: boolean = DEFAULT_OPTIONS.infiniteTroops;
  @state() private compactMap: boolean = DEFAULT_OPTIONS.compactMap;
  @state() private maxTimer: boolean = DEFAULT_OPTIONS.maxTimer;
  @state() private maxTimerValue: number | undefined =
    DEFAULT_OPTIONS.maxTimerValue;
  @state() private instantBuild: boolean = DEFAULT_OPTIONS.instantBuild;
  @state() private randomSpawn: boolean = DEFAULT_OPTIONS.randomSpawn;
  @state() private useRandomMap: boolean = DEFAULT_OPTIONS.useRandomMap;
  @state() private gameMode: GameMode = DEFAULT_OPTIONS.gameMode;
  @state() private teamCount: TeamCountConfig = DEFAULT_OPTIONS.teamCount;
  @state() private goldMultiplier: boolean = DEFAULT_OPTIONS.goldMultiplier;
  @state() private goldMultiplierValue: number | undefined =
    DEFAULT_OPTIONS.goldMultiplierValue;
  @state() private startingGold: boolean = DEFAULT_OPTIONS.startingGold;
  @state() private startingGoldValue: number | undefined =
    DEFAULT_OPTIONS.startingGoldValue;

  @state() private disabledUnits: UnitType[] = [
    ...DEFAULT_OPTIONS.disabledUnits,
  ];
  @state() private customAlliances: boolean = DEFAULT_OPTIONS.customAlliances;
  @state() private customAllianceMinutes: number | undefined =
    DEFAULT_OPTIONS.customAllianceMinutes;
  @state() private waterNukes: boolean = DEFAULT_OPTIONS.waterNukes;
  @state() private doomsdayClock: boolean = DEFAULT_OPTIONS.doomsdayClock;
  @state() private doomsdayClockSpeed: DoomsdayClockSpeed =
    DEFAULT_OPTIONS.doomsdayClockSpeed;
  @state() private overtime: boolean = DEFAULT_OPTIONS.overtime;
  @state() private mutators: MutatorsConfig = DEFAULT_OPTIONS.mutators;
  @state() private overtimeStartMinutes: number | undefined =
    DEFAULT_OPTIONS.overtimeStartMinutes;
  // Drives the Start Game button's busy state. Without it the click produces
  // nothing visible until every await in startGame() settles, which reads as
  // a hang rather than as loading whenever the network is slow or absent.
  @state() private starting: boolean = false;
  // Identifies the current start attempt. Bumped on every start and on every
  // close, so an attempt that outlives its modal can tell it has been retired.
  private startAttempt: number = 0;
  // Which attempt the starting overlay is up for, so a retired attempt's
  // cleanup cannot hide the overlay a newer attempt has shown.
  private overlayAttempt: number = 0;

  private mapLoader = terrainMapFileLoader;

  connectedCallback() {
    super.connectedCallback();
    void this.loadNationCount();
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("main.solo") || "Solo",
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
    });
  }

  protected renderBody() {
    const inputCards = [
      html`<toggle-input-card
        .labelKey=${"game_settings.max_timer"}
        .checked=${this.maxTimer}
        .inputId=${"end-timer-value"}
        .inputMin=${1}
        .inputMax=${120}
        .inputValue=${this.maxTimerValue}
        .inputAriaLabel=${translateText("game_settings.max_timer")}
        .inputPlaceholder=${translateText("game_settings.mins_placeholder")}
        .defaultInputValue=${30}
        .minValidOnEnable=${1}
        .onToggle=${this.handleMaxTimerToggle}
        .onInput=${this.handleMaxTimerValueChanges}
        .onKeyDown=${this.handleMaxTimerValueKeyDown}
      ></toggle-input-card>`,
      html`<toggle-input-card
        .labelKey=${"game_settings.gold_multiplier"}
        .checked=${this.goldMultiplier}
        .inputId=${"gold-multiplier-value"}
        .inputMin=${0.1}
        .inputMax=${1000}
        .inputStep=${"any"}
        .inputValue=${this.goldMultiplierValue}
        .inputAriaLabel=${translateText("game_settings.gold_multiplier")}
        .inputPlaceholder=${"2.0x"}
        .defaultInputValue=${2}
        .minValidOnEnable=${0.1}
        .onToggle=${this.handleGoldMultiplierToggle}
        .onChange=${this.handleGoldMultiplierValueChanges}
        .onKeyDown=${this.handleGoldMultiplierValueKeyDown}
      ></toggle-input-card>`,
      html`<toggle-input-card
        .labelKey=${"game_settings.starting_gold"}
        .checked=${this.startingGold}
        .inputId=${"starting-gold-value"}
        .inputMin=${0.1}
        .inputMax=${1000}
        .inputStep=${"any"}
        .inputValue=${this.startingGoldValue}
        .inputAriaLabel=${translateText("game_settings.starting_gold")}
        .inputPlaceholder=${"5"}
        .defaultInputValue=${5}
        .minValidOnEnable=${0.1}
        .onToggle=${this.handleStartingGoldToggle}
        .onChange=${this.handleStartingGoldValueChanges}
        .onKeyDown=${this.handleStartingGoldValueKeyDown}
      ></toggle-input-card>`,
      html`<toggle-input-card
        .labelKey=${"game_settings.custom_alliances"}
        .checked=${this.customAlliances}
        .inputMin=${0}
        .inputMax=${15}
        .inputStep=${1}
        .inputValue=${this.customAllianceMinutes}
        .inputAriaLabel=${translateText("game_settings.custom_alliances")}
        .inputPlaceholder=${translateText("game_settings.mins_placeholder")}
        .defaultInputValue=${0}
        .minValidOnEnable=${0}
        .zeroLabel=${`(${translateText("public_game_modifier.disable_alliances")})`}
        .onToggle=${this.handleCustomAlliancesToggle}
        .onInput=${this.handleCustomAllianceMinutesInput}
        .onKeyDown=${this.handleCustomAllianceMinutesKeyDown}
      ></toggle-input-card>`,
      html`<toggle-input-card
        .labelKey=${"game_settings.overtime"}
        .checked=${this.overtime}
        .inputMin=${1}
        .inputMax=${120}
        .inputStep=${1}
        .inputValue=${this.overtimeStartMinutes}
        .inputAriaLabel=${translateText("game_settings.overtime")}
        .inputPlaceholder=${translateText("game_settings.mins_placeholder")}
        .defaultInputValue=${30}
        .minValidOnEnable=${1}
        .onToggle=${this.handleOvertimeToggle}
        .onInput=${this.handleOvertimeMinutesInput}
        .onKeyDown=${this.handleOvertimeMinutesKeyDown}
      ></toggle-input-card>`,
    ];

    return html`
      <div class="flex flex-col h-full">
        <div
          class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-6 pt-4 pb-6 mr-1 mx-auto w-full max-w-5xl"
        >
          <game-config-settings
            class="block"
            .sectionGapClass=${"space-y-6"}
            .settings=${{
              map: {
                selected: this.selectedMap,
                useRandom: this.useRandomMap,
              },
              difficulty: {
                selected: this.selectedDifficulty,
                disabled: this.nations === 0,
              },
              gameMode: {
                selected: this.gameMode,
              },
              teamCount: {
                selected: this.teamCount,
              },
              options: {
                titleKey: "game_settings.options",
                bots: {
                  value: this.bots,
                  labelKey: "game_settings.bots",
                  disabledKey: "common.disabled",
                },
                nations: {
                  value: this.nations,
                  defaultValue: this.defaultNationCount,
                  labelKey: "game_settings.nations",
                  disabledKey: "common.disabled",
                },
                toggles: [
                  {
                    labelKey: "game_settings.instant_build",
                    checked: this.instantBuild,
                  },
                  {
                    labelKey: "game_settings.random_spawn",
                    checked: this.randomSpawn,
                  },
                  {
                    labelKey: "game_settings.infinite_gold",
                    checked: this.infiniteGold,
                  },
                  {
                    labelKey: "game_settings.infinite_troops",
                    checked: this.infiniteTroops,
                  },
                  {
                    labelKey: "game_settings.compact_map",
                    checked: this.compactMap,
                  },
                  {
                    labelKey: "game_settings.water_nukes",
                    checked: this.waterNukes,
                  },
                  {
                    labelKey: "game_settings.doomsday_clock",
                    checked: this.doomsdayClock,
                    doomsdayClockSpeed: this.doomsdayClockSpeed,
                  },
                  ...mutatorToggles(this.mutators),
                ],
                inputCards,
              },
              unitTypes: {
                titleKey: "game_settings.disable_units",
                disabledUnits: this.disabledUnits,
              },
            }}
            @map-selected=${this.handleConfigMapSelected}
            @random-map-selected=${this.handleConfigRandomMapSelected}
            @difficulty-selected=${this.handleConfigDifficultySelected}
            @doomsday-clock-speed-selected=${this
              .handleConfigDoomsdayClockSpeedSelected}
            @game-mode-selected=${this.handleConfigGameModeSelected}
            @team-count-selected=${this.handleConfigTeamCountSelected}
            @bots-changed=${this.handleBotsChange}
            @nations-changed=${this.handleNationsChange}
            @option-toggle-changed=${this.handleConfigOptionToggleChanged}
            @unit-toggle-changed=${this.handleConfigUnitToggleChanged}
          ></game-config-settings>
        </div>

        <!-- Footer Action -->
        <div class="p-6 border-t border-white/10 bg-black/20 shrink-0">
          <o-button
            variant="primary"
            width="block"
            size="lg"
            translationKey=${this.starting
              ? "game_settings.starting"
              : "game_settings.start"}
            .disable=${this.starting}
            @click=${this.startGame}
          ></o-button>
        </div>
      </div>
    `;
  }

  protected onClose(): void {
    // Retires whatever start is still in flight. resetOptions() below hands
    // back a live button, so the player can close, reopen and start again
    // while the previous attempt is still resolving — and that attempt is
    // now describing settings the modal no longer holds. Without this, both
    // attempts dispatch join-lobby with different gameIDs and whichever
    // resolves last wins, which can be the one the player abandoned.
    this.startAttempt++;
    // If the retired attempt still owned the starting overlay it never
    // dispatched join-lobby, so nothing downstream will hide it: without
    // this, dismissing the modal mid-preparation leaves a full-screen
    // overlay blocking the menu until the preparation deadline settles.
    if (this.overlayAttempt !== 0) {
      this.overlayAttempt = 0;
      const startingModal = document.querySelector("game-starting-modal");
      if (startingModal instanceof GameStartingModal) {
        startingModal.hide();
      }
    }
    this.resetOptions();
  }

  /**
   * Starts a solo game on the default settings without opening the modal,
   * with the in-game tutorial switched back on (the play page's Tutorial
   * card for new players).
   */
  public async startTutorial(): Promise<void> {
    // The modal never opens on this path, so onOpen's prewarm never runs.
    // Overlap it with the manifest load below.
    void prewarmCosmetics();
    this.resetOptions();
    // A nation count of 0 means "nations disabled"; wait for the real one.
    await this.loadNationCount();
    new UserSettings().setTutorialDismissed(false);
    await this.startGame();
  }

  // Reset all transient form state to ensure clean slate
  private resetOptions(): void {
    // Belt and braces with the finally in startGame(): closing and reopening
    // the modal must always give the player a live Start button back, whatever
    // left the previous attempt in flight.
    this.starting = false;
    this.selectedMap = DEFAULT_OPTIONS.selectedMap;
    this.selectedDifficulty = DEFAULT_OPTIONS.selectedDifficulty;
    this.gameMode = DEFAULT_OPTIONS.gameMode;
    this.useRandomMap = DEFAULT_OPTIONS.useRandomMap;
    this.bots = DEFAULT_OPTIONS.bots;
    this.nations = 0;
    this.defaultNationCount = 0;
    this.infiniteGold = DEFAULT_OPTIONS.infiniteGold;
    this.infiniteTroops = DEFAULT_OPTIONS.infiniteTroops;
    this.compactMap = DEFAULT_OPTIONS.compactMap;
    this.maxTimer = DEFAULT_OPTIONS.maxTimer;
    this.maxTimerValue = DEFAULT_OPTIONS.maxTimerValue;
    this.instantBuild = DEFAULT_OPTIONS.instantBuild;
    this.randomSpawn = DEFAULT_OPTIONS.randomSpawn;
    this.teamCount = DEFAULT_OPTIONS.teamCount;
    this.disabledUnits = [...DEFAULT_OPTIONS.disabledUnits];
    this.goldMultiplier = DEFAULT_OPTIONS.goldMultiplier;
    this.goldMultiplierValue = DEFAULT_OPTIONS.goldMultiplierValue;
    this.startingGold = DEFAULT_OPTIONS.startingGold;
    this.startingGoldValue = DEFAULT_OPTIONS.startingGoldValue;
    this.customAlliances = DEFAULT_OPTIONS.customAlliances;
    this.customAllianceMinutes = DEFAULT_OPTIONS.customAllianceMinutes;
    this.waterNukes = DEFAULT_OPTIONS.waterNukes;
    this.doomsdayClock = DEFAULT_OPTIONS.doomsdayClock;
    this.doomsdayClockSpeed = DEFAULT_OPTIONS.doomsdayClockSpeed;
    this.overtime = DEFAULT_OPTIONS.overtime;
    this.overtimeStartMinutes = DEFAULT_OPTIONS.overtimeStartMinutes;
    this.mutators = DEFAULT_OPTIONS.mutators;
  }

  protected onOpen(): void {
    void this.loadNationCount();
    // Spend the cosmetics round trip while the player is picking a map, not
    // after they commit. startGame() still resolves cosmetics properly; this
    // only moves the network time off the click, for the slow-but-reachable
    // case. It does not help when the backend is unreachable: fetchCosmetics
    // deliberately does not cache a failure, so the click re-pays one bounded
    // attempt. Remembering an unreachable backend is OPE-403.
    void prewarmCosmetics();
  }

  private handleSelectRandomMap() {
    this.useRandomMap = true;
    this.selectedMap = getRandomMapType();
    void this.loadNationCount();
  }

  private handleConfigRandomMapSelected = () => {
    this.handleSelectRandomMap();
  };

  private handleMapSelection(value: GameMapType) {
    this.selectedMap = value;
    this.useRandomMap = false;
    void this.loadNationCount();
  }

  private handleConfigMapSelected = (e: Event) => {
    const customEvent = e as CustomEvent<{ map: GameMapType }>;
    this.handleMapSelection(customEvent.detail.map);
  };

  private handleDifficultySelection(value: Difficulty) {
    this.selectedDifficulty = value;
  }

  private handleConfigDifficultySelected = (e: Event) => {
    const customEvent = e as CustomEvent<{ difficulty: Difficulty }>;
    this.handleDifficultySelection(customEvent.detail.difficulty);
  };

  private handleConfigDoomsdayClockSpeedSelected = (e: Event) => {
    const customEvent = e as CustomEvent<{ speed: DoomsdayClockSpeed }>;
    this.doomsdayClockSpeed = customEvent.detail.speed;
  };

  private handleConfigGameModeSelected = (e: Event) => {
    const customEvent = e as CustomEvent<{ mode: GameMode }>;
    this.handleGameModeSelection(customEvent.detail.mode);
  };

  private handleConfigTeamCountSelected = (e: Event) => {
    const customEvent = e as CustomEvent<{ count: TeamCountConfig }>;
    this.handleTeamCountSelection(customEvent.detail.count);
  };

  private handleCompactMapChange(val: boolean) {
    this.compactMap = val;
    this.bots = getBotsForCompactMap(this.bots, val);
    this.nations = getNationsForCompactMap(
      this.nations,
      this.defaultNationCount,
      val,
    );
  }

  private handleConfigOptionToggleChanged = (e: Event) => {
    const customEvent = e as CustomEvent<{
      labelKey: string;
      checked: boolean;
    }>;
    const { labelKey, checked } = customEvent.detail;

    switch (labelKey) {
      case "game_settings.instant_build":
        this.instantBuild = checked;
        break;
      case "game_settings.random_spawn":
        this.randomSpawn = checked;
        break;
      case "game_settings.infinite_gold":
        this.infiniteGold = checked;
        break;
      case "game_settings.infinite_troops":
        this.infiniteTroops = checked;
        break;
      case "game_settings.compact_map":
        this.handleCompactMapChange(checked);
        break;
      case "game_settings.water_nukes":
        this.waterNukes = checked;
        break;
      case "game_settings.doomsday_clock":
        this.doomsdayClock = checked;
        break;
      default: {
        const mutator = mutatorForLabel(labelKey);
        if (mutator !== undefined) {
          this.mutators = { ...this.mutators, [mutator]: checked };
        }
        break;
      }
    }
  };

  private handleConfigUnitToggleChanged = (e: Event) => {
    const customEvent = e as CustomEvent<{ unit: UnitType; checked: boolean }>;
    const { unit, checked } = customEvent.detail;
    this.disabledUnits = getUpdatedDisabledUnits(
      this.disabledUnits,
      unit,
      checked,
    );
  };

  private handleBotsChange = (e: Event) => {
    const customEvent = e as CustomEvent<{ value: number }>;
    const value = customEvent.detail.value;
    if (isNaN(value) || value < 0 || value > 400) {
      return;
    }
    this.bots = value;
  };

  private handleNationsChange = (e: Event) => {
    const customEvent = e as CustomEvent<{ value: number }>;
    const value = customEvent.detail.value;
    if (isNaN(value) || value < 0 || value > 400) {
      return;
    }
    this.nations = value;
  };

  private handleMaxTimerToggle = (
    checked: boolean,
    value: number | string | undefined,
  ) => {
    this.maxTimer = checked;
    this.maxTimerValue = toOptionalNumber(value);
  };

  private handleGoldMultiplierToggle = (
    checked: boolean,
    value: number | string | undefined,
  ) => {
    this.goldMultiplier = checked;
    this.goldMultiplierValue = toOptionalNumber(value);
  };

  private handleStartingGoldToggle = (
    checked: boolean,
    value: number | string | undefined,
  ) => {
    this.startingGold = checked;
    this.startingGoldValue = toOptionalNumber(value);
  };

  private handleCustomAlliancesToggle = (
    checked: boolean,
    value: number | string | undefined,
  ) => {
    this.customAlliances = checked;
    this.customAllianceMinutes = toOptionalNumber(value);
  };

  private handleOvertimeToggle = (
    checked: boolean,
    value: number | string | undefined,
  ) => {
    this.overtime = checked;
    this.overtimeStartMinutes = toOptionalNumber(value);
  };

  private handleOvertimeMinutesKeyDown = (e: KeyboardEvent) => {
    preventDisallowedKeys(e, ["-", "+", "e"]);
  };

  private handleOvertimeMinutesInput = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const value = parseBoundedIntegerFromInput(input, {
      min: 1,
      max: 120,
      stripPattern: /[e+-]/gi,
    });
    if (value === undefined) {
      return;
    }
    this.overtimeStartMinutes = value;
  };

  private handleCustomAllianceMinutesKeyDown = (e: KeyboardEvent) => {
    preventDisallowedKeys(e, ["-", "+", "e"]);
  };

  private handleCustomAllianceMinutesInput = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const value = parseBoundedIntegerFromInput(input, { min: 0, max: 15 });
    if (value === undefined) {
      return;
    }
    this.customAllianceMinutes = value;
  };

  private handleMaxTimerValueKeyDown = (e: KeyboardEvent) => {
    preventDisallowedKeys(e, ["-", "+", "e"]);
  };

  private getEndTimerInput(): HTMLInputElement | null {
    return (
      (this.renderRoot.querySelector(
        "#end-timer-value",
      ) as HTMLInputElement | null) ??
      (this.querySelector("#end-timer-value") as HTMLInputElement | null)
    );
  }

  private handleMaxTimerValueChanges = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const value = parseBoundedIntegerFromInput(input, {
      min: 1,
      max: 120,
      stripPattern: /[e+-]/gi,
    });

    this.maxTimerValue = value;
  };

  private handleGoldMultiplierValueKeyDown = (e: KeyboardEvent) => {
    preventDisallowedKeys(e, ["+", "-", "e", "E"]);
  };

  private handleGoldMultiplierValueChanges = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const value = parseBoundedFloatFromInput(input, { min: 0.1, max: 1000 });

    if (value === undefined) {
      this.goldMultiplierValue = undefined;
      input.value = "";
    } else {
      this.goldMultiplierValue = value;
    }
  };

  private handleStartingGoldValueKeyDown = (e: KeyboardEvent) => {
    preventDisallowedKeys(e, ["-", "+", "e", "E"]);
  };

  private handleStartingGoldValueChanges = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const value = parseBoundedFloatFromInput(input, {
      min: 0.1,
      max: 1000,
    });

    if (value === undefined) {
      this.startingGoldValue = undefined;
      input.value = "";
    } else {
      this.startingGoldValue = value;
    }
  };

  private handleGameModeSelection(value: GameMode) {
    this.gameMode = value;
  }

  private handleTeamCountSelection(value: TeamCountConfig) {
    this.teamCount = value;
  }

  /**
   * The name and cosmetics the dispatch needs. Both are local: the name comes
   * from the username field and the cosmetics from the catalog bundled with
   * the game (a failed load degrades to default cosmetics).
   */
  private async resolveNameAndCosmetics(
    usernameInput: UsernameInput | null,
  ): Promise<{ playerName: string; cosmetics: PlayerCosmetics }> {
    return {
      playerName: usernameInput?.getUsername() ?? fallbackPlayerName(),
      cosmetics: await getPlayerCosmetics(),
    };
  }

  private async startGame() {
    // A second click while the first is still resolving would dispatch a
    // second join-lobby for a different gameID.
    if (this.starting) return;
    // Validate and clamp maxTimer setting before starting
    let finalMaxTimerValue: number | undefined = undefined;
    if (this.maxTimer) {
      if (!this.maxTimerValue || this.maxTimerValue <= 0) {
        console.error("Max timer is enabled but no valid value is set");
        await showInGameAlert(
          translateText("single_modal.max_timer_invalid") ||
            "Please enter a valid max timer value (1-120 minutes)",
        );
        // Focus the input
        const input = this.getEndTimerInput();
        if (input) {
          input.focus();
          input.select();
        }
        return;
      }
      // Clamp value to valid range
      finalMaxTimerValue = Math.max(1, Math.min(120, this.maxTimerValue));
    }

    // Everything past this point awaits something, some of it network-bound.
    // Hold the button in its busy state until join-lobby is away so the wait
    // reads as loading rather than as a dead click.
    this.starting = true;
    const attempt = ++this.startAttempt;
    // The full-screen starting overlay, up from the click rather than at
    // prestart: it also covers Main's own awaits after the dispatch. On
    // success GameRenderer hides it (a canPlay() refusal hides it in
    // handleJoinLobby); an attempt that never dispatches reaches neither, so
    // onClose (or the finally below, for exits without a close) releases it.
    const startingModal = document.querySelector("game-starting-modal");
    const overlay =
      startingModal instanceof GameStartingModal ? startingModal : null;
    this.overlayAttempt = attempt;
    overlay?.show();
    try {
      console.log(
        `Starting single player game with map: ${GameMapType[this.selectedMap as keyof typeof GameMapType]}${this.useRandomMap ? " (Randomly selected)" : ""}`,
      );
      const clientID = generateID();
      const gameID = generateID();

      const usernameInput = document.querySelector(
        "username-input",
      ) as UsernameInput | null;

      // Resolved before the dispatch rather than inside it, so every wait is
      // attributable to the busy button above.
      const { playerName, cosmetics } =
        await this.resolveNameAndCosmetics(usernameInput);

      // Retired while this was resolving — the modal was closed, and possibly
      // reopened and started again. The live attempt owns the start; this one
      // would otherwise race it into join-lobby with stale settings.
      //
      // A start has exactly two side effects that leave this component, and
      // BOTH must sit behind this check. Anything added here that escapes the
      // component needs the same gate:
      //   1. awaitMidgameAd() — shows the player a real ad, so an abandoned
      //      attempt reaching it advertises a game that never starts, and a
      //      reopened modal can put a second request in flight beside it.
      //   2. the join-lobby dispatch — and everything downstream of it,
      //      including Main's gameplayStart() and incrementGamesPlayed().
      // resolveNameAndCosmetics() above is deliberately NOT gated: its only
      // writes are validating stored cosmetic selections against the catalog
      // and profile, which happens on any cosmetics resolution (menu
      // background, store, inventory) rather than as a consequence of this
      // start.
      if (attempt !== this.startAttempt) return;

      this.dispatchEvent(
        new CustomEvent("join-lobby", {
          detail: {
            gameID: gameID,
            gameStartInfo: {
              gameID: gameID,
              players: [
                {
                  clientID,
                  username: playerName,
                  clanTag: usernameInput?.getClanTag() ?? null,
                  cosmetics,
                },
              ],
              config: {
                gameMap: this.selectedMap,
                gameMapSize: this.compactMap
                  ? GameMapSize.Compact
                  : GameMapSize.Normal,
                gameType: GameType.Singleplayer,
                gameMode: this.gameMode,
                playerTeams: this.teamCount,
                difficulty: this.selectedDifficulty,
                maxTimerValue: finalMaxTimerValue,
                bots: this.bots,
                infiniteGold: this.infiniteGold,
                donateGold: this.gameMode === GameMode.Team,
                donateTroops: this.gameMode === GameMode.Team,
                infiniteTroops: this.infiniteTroops,
                instantBuild: this.instantBuild,
                randomSpawn: this.randomSpawn,
                disabledUnits: this.disabledUnits.filter(
                  (unit): unit is UnitType =>
                    Object.values(UnitType).includes(unit),
                ),
                nations: sliderToNationsConfig(
                  this.nations,
                  this.defaultNationCount,
                ),
                ...(this.goldMultiplier && this.goldMultiplierValue
                  ? { goldMultiplier: this.goldMultiplierValue }
                  : {}),
                ...(this.startingGold && this.startingGoldValue !== undefined
                  ? {
                      startingGold: Math.round(
                        this.startingGoldValue * 1_000_000,
                      ),
                    }
                  : {}),
                ...(this.customAlliances
                  ? { customAllianceDuration: this.customAllianceMinutes ?? 0 }
                  : {}),
                ...(this.waterNukes ? { waterNukes: true } : {}),
                ...(this.doomsdayClock
                  ? {
                      doomsdayClock: {
                        enabled: true,
                        speed: this.doomsdayClockSpeed,
                      },
                    }
                  : {}),
                ...(this.overtime
                  ? {
                      overtime: {
                        enabled: true,
                        startMinutes: this.overtimeStartMinutes ?? 30,
                      },
                    }
                  : {}),
                ...(activeMutators(this.mutators).length > 0
                  ? { mutators: mutatorsConfig(this.mutators) }
                  : {}),
              },
              lobbyCreatedAt: Date.now(), // ms; server should be authoritative in MP
            },
            source: "singleplayer",
          } satisfies JoinLobbyEvent,
          bubbles: true,
          composed: true,
        }),
      );
      // The overlay is the join pipeline's now — GameRenderer or Main's
      // canPlay() refusal hides it. Disowning it keeps the close below (and
      // any later onClose) from taking it down mid game-load.
      this.overlayAttempt = 0;
      this.close();
    } finally {
      // Only if this attempt is still the live one: a retired attempt
      // settling later must not clear the busy state of the one that
      // replaced it.
      if (attempt === this.startAttempt) this.starting = false;
      // An attempt that still owns the overlay dispatched nothing, so no
      // downstream hide point will ever fire for it. onClose normally
      // releases it the moment the modal is dismissed; this catches exits
      // without a close, like resolveNameAndCosmetics() throwing.
      if (this.overlayAttempt === attempt) {
        this.overlayAttempt = 0;
        overlay?.hide();
      }
    }
  }

  private async loadNationCount() {
    const currentMap = this.selectedMap;
    try {
      const mapData = this.mapLoader.getMapData(currentMap);
      const manifest = await mapData.manifest();
      // Only update if the map hasn't changed
      if (this.selectedMap === currentMap) {
        this.defaultNationCount = manifest.nations.length;
        this.nations = this.compactMap
          ? Math.max(0, Math.floor(manifest.nations.length * 0.25))
          : manifest.nations.length;
      }
    } catch (error) {
      console.warn("Failed to load nation count", error);
      // Leave existing values unchanged so the UI stays consistent
    }
  }
}
