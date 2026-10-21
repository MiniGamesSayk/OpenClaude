import {
  Cosmetics,
  Effect,
  isNukeExplosionEffect,
} from "@openfront/shared/CosmeticSchemas";
import { PlayerCosmetics } from "@openfront/shared/WireSchemas";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  fetchCosmetics,
  resolveCosmetics,
  translateCosmetic,
} from "../Cosmetics";
import { EquippedCosmetic, equippedCosmetics } from "../EquippedCosmetics";
import { translateText } from "../Utils";
import "./EffectPreview";
import { renderPatternPreview } from "./PatternPreview";

const rarityRing: Record<string, string> = {
  common: "ring-white/15",
  uncommon: "ring-green-400/50",
  rare: "ring-blue-400/50",
  epic: "ring-purple-300/50",
  legendary: "ring-orange-400/60",
};

/**
 * The cosmetics a player has equipped, as a row of small tiles under their name.
 */
@customElement("equipped-cosmetics-row")
export class EquippedCosmeticsRow extends LitElement {
  @property({ attribute: false })
  cosmetics: PlayerCosmetics = {};

  @state() private catalog: Cosmetics | null = null;

  createRenderRoot() {
    return this;
  }

  protected updated(): void {
    // Light DOM, so the host stays a flex item even when nothing renders and
    // would add a gap under the identity row for a player with no cosmetics.
    this.toggleAttribute("hidden", this.childElementCount === 0);
  }

  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    this.catalog = await fetchCosmetics();
  }

  private displayName(equipped: EquippedCosmetic): string {
    if (equipped.type === "crown")
      return translateCosmetic("crowns", equipped.name);
    if (equipped.type === "effect")
      return translateCosmetic("effects", equipped.name);
    return translateCosmetic("territory_patterns.pattern", equipped.name);
  }

  private renderPreview(equipped: EquippedCosmetic): TemplateResult {
    if (equipped.pattern !== null) {
      return renderPatternPreview(equipped.pattern, 48, 48);
    }
    if (equipped.imageUrl !== null) {
      return html`<img
        src=${equipped.imageUrl}
        alt=""
        class="h-full w-full object-contain pointer-events-none"
        draggable="false"
        loading="lazy"
      />`;
    }
    const effect = equipped.resolved?.cosmetic as Effect | undefined;
    if (effect === undefined) {
      return html`<span class="text-xs font-bold text-white/40">?</span>`;
    }
    if (isNukeExplosionEffect(effect)) {
      return effect.attributes.type === "sparkles"
        ? html`<sparkles-swatch
            class="block h-full w-full"
            .explosion=${effect.attributes}
          ></sparkles-swatch>`
        : html`<shockwave-swatch
            class="block h-full w-full"
            .explosion=${effect.attributes}
          ></shockwave-swatch>`;
    }
    return html`<trail-swatch
      class="block h-full w-full"
      .trail=${effect.attributes}
    ></trail-swatch>`;
  }

  private renderTile(equipped: EquippedCosmetic): TemplateResult {
    const name = this.displayName(equipped);
    const rarity = equipped.resolved?.cosmetic?.rarity ?? "";
    const ring = rarityRing[rarity] ?? "ring-white/15";

    return html`
      <div
        class=${`relative h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-white/5 p-1 ring-1 ${ring}`}
        title=${name}
        aria-label=${name}
      >
        ${this.renderPreview(equipped)}
      </div>
    `;
  }

  render() {
    const equipped = equippedCosmetics(
      this.cosmetics,
      resolveCosmetics(this.catalog),
    );
    if (equipped.length === 0) return nothing;

    return html`
      <div class="flex items-center gap-2">
        <span
          class="text-xs font-semibold uppercase tracking-wider text-zinc-400"
        >
          ${translateText("player_panel.cosmetics")}
        </span>
        <div class="flex flex-wrap items-center gap-1.5">
          ${equipped.map((w) => this.renderTile(w))}
        </div>
      </div>
    `;
  }
}
