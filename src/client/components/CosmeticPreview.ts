import {
  Crown,
  Effect,
  Flag,
  isNukeExplosionEffect,
  Pattern,
  Skin,
} from "@openfront/shared/CosmeticSchemas";
import { PlayerPattern } from "@openfront/shared/WireSchemas";
import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ResolvedCosmetic } from "../Cosmetics";
import { translateText } from "../Utils";
import { cosmeticDisplayName } from "./CosmeticPresentation";
import "./EffectPreview";
import { observeNear } from "./LazyVisibility";
import { renderPatternPreview } from "./PatternPreview";

@customElement("cosmetic-preview")
export class CosmeticPreview extends LitElement {
  @property({ attribute: false })
  resolved!: ResolvedCosmetic;

  @property({ type: String })
  size: "card" | "detail" = "card";

  // Card previews sit in grids as long as the catalog, so each one only
  // holds its canvas, animation or image while it is near the screen.
  @state() private near = false;
  private stopObserving: (() => void) | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    // CosmeticPreview is used inside flex/grid cards and also in the compact
    // inventory loadout. Make the light-DOM host participate in those layouts
    // so previews with no intrinsic size (trail/structure effects) still get a
    // real box to paint into.
    this.classList.add("block", "h-full", "w-full");
    this.stopObserving = observeNear(this, (near) => {
      this.near = near;
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopObserving?.();
    this.stopObserving = null;
    this.near = false;
  }

  render() {
    return html`<div
      data-cosmetic-preview=${this.resolved.cosmetic === null
        ? "default"
        : this.resolved.type}
      class=${this.size === "detail" ? "h-full w-full" : "aspect-square w-full"}
    >
      ${this.near || !this.deferrable()
        ? this.renderResolvedPreview()
        : nothing}
    </div>`;
  }

  // Text previews size their own box and cost nothing to draw; withholding
  // them would only collapse the card until it scrolled near.
  private deferrable(): boolean {
    if (this.size !== "card") return false;
    const type = this.resolved.type;
    return (
      type === "pattern" ||
      type === "effect" ||
      type === "flag" ||
      type === "crown" ||
      type === "skin"
    );
  }

  private renderResolvedPreview(): TemplateResult {
    if (this.resolved.type === "pattern") {
      const cosmetic = this.resolved.cosmetic;
      const playerPattern: PlayerPattern | null =
        cosmetic === null
          ? null
          : {
              name: cosmetic.name,
              patternData: (cosmetic as Pattern).pattern,
              colorPalette: this.resolved.colorPalette ?? undefined,
            };
      return renderPatternPreview(playerPattern, 150, 150);
    }

    if (this.resolved.type === "skin") {
      const cosmetic = this.resolved.cosmetic as Skin | null;
      if (cosmetic === null) {
        return this.renderDefaultPreview();
      }
      return html`<img
        src=${cosmetic.url}
        alt=${cosmeticDisplayName(this.resolved)}
        class="w-full h-full object-contain pointer-events-none"
        draggable="false"
        loading="lazy"
      />`;
    }

    if (this.resolved.type === "effect") {
      const cosmetic = this.resolved.cosmetic as Effect | null;
      if (cosmetic === null) {
        return this.renderDefaultPreview();
      }
      if (isNukeExplosionEffect(cosmetic)) {
        if (cosmetic.attributes.type === "sparkles") {
          return html`<sparkles-swatch
            class="block w-full h-full"
            .explosion=${cosmetic.attributes}
          ></sparkles-swatch>`;
        }
        return html`<shockwave-swatch
          class="block w-full h-full"
          .explosion=${cosmetic.attributes}
        ></shockwave-swatch>`;
      }
      return html`<effect-scene
        class="block w-full h-full"
        .effect=${cosmetic}
      ></effect-scene>`;
    }

    if (this.resolved.type === "crown") {
      const cosmetic = this.resolved.cosmetic as Crown | null;
      if (cosmetic === null) {
        return this.renderDefaultPreview();
      }
      return html`<img
        src=${cosmetic.url}
        alt=${cosmeticDisplayName(this.resolved)}
        class="w-full h-full object-contain pointer-events-none"
        draggable="false"
        loading="lazy"
      />`;
    }

    const flag = this.resolved.cosmetic as Flag;
    return html`<img
      src=${flag.url}
      alt=${cosmeticDisplayName(this.resolved)}
      class="w-full h-full object-contain pointer-events-none"
      draggable="false"
      loading="lazy"
      @error=${(event: Event) => {
        const image = event.currentTarget as HTMLImageElement;
        const fallback = "/flags/xx.svg";
        if (image.src && !image.src.endsWith(fallback)) {
          image.src = fallback;
        }
      }}
    />`;
  }

  private renderDefaultPreview(): TemplateResult {
    return html`<div
      class="w-full h-full flex items-center justify-center text-white/40 text-xs uppercase"
    >
      ${translateText("territory_patterns.pattern.default")}
    </div>`;
  }
}
