#!/usr/bin/env node
// Regenerates the bundled, free cosmetics catalog
// (resources/cosmetics/cosmetics.json) and the artwork it points at.
//
//  - flags: the SVGs in resources/flags that are not plain country flags
//    (resources/countries.json) -- those are already selectable as
//    "country:<code>" flags.
//  - colorPalettes, patterns, skins, crowns, effects: OpenClaude's own
//    original cosmetics, defined below. Patterns are encoded here in the bit
//    format read by packages/shared/src/PatternDecoder.ts; skins and crowns
//    are SVGs written to resources/cosmetics/{skins,crowns}/.
//
// Output is deterministic (seeded PRNG, fixed ordering), so running it twice
// produces identical files. Any other top-level section already in the
// catalog (packs, subscriptions, ...) is kept as it is.
//
//   node scripts/generate-cosmetics-catalog.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "resources/cosmetics/cosmetics.json");
const skinsDir = path.join(root, "resources/cosmetics/skins");
const crownsDir = path.join(root, "resources/cosmetics/crowns");
const ARTIST = "OpenClaude";

// ---------------------------------------------------------------------------
// Helpers

function slug(name) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

/** mulberry32: small, fast, deterministic PRNG. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Round for compact, stable SVG output. */
const r1 = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// Pattern encoding (inverse of decodePatternData in PatternDecoder.ts)
//
//   byte 0: version (0)
//   byte 1: scale (bits 0-2) | (width - 2) low 5 bits (bits 3-7)
//   byte 2: (width - 2) high 2 bits (bits 0-1) | (height - 2) (bits 2-7)
//   then 1 bit per cell, row-major, LSB first: 0 = primary, 1 = secondary.
// width 2..129, height 2..65, scale 0..7.

function encodePattern(width, height, scale, isSecondary) {
  if (width < 2 || width > 129) throw new Error(`bad width ${width}`);
  if (height < 2 || height > 65) throw new Error(`bad height ${height}`);
  if (scale < 0 || scale > 7) throw new Error(`bad scale ${scale}`);
  const w = width - 2;
  const h = height - 2;
  const bits = width * height;
  const bytes = new Uint8Array(3 + ((bits + 7) >> 3));
  bytes[0] = 0;
  bytes[1] = (scale & 0x07) | ((w & 0x1f) << 3);
  bytes[2] = ((w >> 5) & 0x03) | ((h & 0x3f) << 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isSecondary(x, y)) continue;
      const idx = y * width + x;
      bytes[3 + (idx >> 3)] |= 1 << (idx & 7);
    }
  }
  return Buffer.from(bytes).toString("base64url");
}

/** Shortest distance from a to b on a ring of size n. */
const wrapDist = (a, b, n) => {
  const d = Math.abs(a - b) % n;
  return Math.min(d, n - d);
};
const torusDist = (x, y, cx, cy, w, h) =>
  Math.hypot(wrapDist(x, cx, w), wrapDist(y, cy, h));

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
function starPolygon(cx, cy, outer, inner, points = 5) {
  const poly = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const rr = i % 2 === 0 ? outer : inner;
    poly.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return poly;
}

// Each pattern: [name, rarity, width, height, scale, isSecondary(x, y)].
// Cells are sampled at their centre (x + 0.5, y + 0.5) where shapes are round.
const PATTERN_DEFS = [
  ["stripes", "common", 2, 8, 1, (_x, y) => y < 3],
  ["pinstripes", "common", 10, 2, 0, (x) => x < 2],
  ["diagonal", "common", 16, 16, 0, (x, y) => (x + y) % 16 < 6],
  ["checkerboard", "common", 2, 2, 3, (x, y) => (x + y) % 2 === 1],
  [
    "polka_dots",
    "uncommon",
    16,
    16,
    0,
    (x, y) =>
      torusDist(x + 0.5, y + 0.5, 4, 4, 16, 16) < 3 ||
      torusDist(x + 0.5, y + 0.5, 12, 12, 16, 16) < 3,
  ],
  [
    "waves",
    "uncommon",
    32,
    12,
    0,
    (x, y) => {
      const c = 6 + 3.2 * Math.sin(((x + 0.5) / 32) * 2 * Math.PI);
      return wrapDist(y + 0.5, c, 12) < 1.6;
    },
  ],
  ["chevrons", "uncommon", 16, 16, 0, (x, y) => (y + Math.abs(x - 8)) % 16 < 5],
  [
    "bricks",
    "common",
    16,
    8,
    1,
    (x, y) => y === 0 || y === 4 || (y < 4 ? x === 0 : x === 8),
  ],
  [
    "honeycomb",
    "rare",
    14,
    24,
    0,
    (x, y) => {
      const px = x + 0.5;
      const py = y + 0.5;
      const centers = [
        [0, 0],
        [14, 0],
        [0, 24],
        [14, 24],
        [7, 12],
      ];
      const d = centers.map(([cx, cy]) => Math.hypot(px - cx, py - cy));
      d.sort((a, b) => a - b);
      return d[1] - d[0] < 1.7;
    },
  ],
  [
    "camouflage",
    "rare",
    32,
    32,
    1,
    (() => {
      const rand = prng(0xca70);
      const waves = [];
      for (let i = 0; i < 7; i++) {
        waves.push({
          kx: 1 + Math.floor(rand() * 3),
          ky: Math.floor(rand() * 4) - 1,
          phase: rand() * 2 * Math.PI,
          amp: 0.5 + rand(),
        });
      }
      return (x, y) => {
        let v = 0;
        for (const w of waves) {
          v +=
            w.amp *
            Math.cos(
              ((w.kx * (x + 0.5)) / 32 + (w.ky * (y + 0.5)) / 32) *
                2 *
                Math.PI +
                w.phase,
            );
        }
        return v > 0.35;
      };
    })(),
  ],
  [
    "crosses",
    "common",
    12,
    12,
    0,
    (x, y) =>
      (Math.abs(x - 6) <= 1 && Math.abs(y - 6) <= 4) ||
      (Math.abs(y - 6) <= 1 && Math.abs(x - 6) <= 4),
  ],
  [
    "starry",
    "epic",
    32,
    32,
    0,
    (() => {
      const a = starPolygon(8, 8.6, 7.6, 3.1);
      const b = starPolygon(24, 24.6, 7.6, 3.1);
      return (x, y) =>
        pointInPolygon(x + 0.5, y + 0.5, a) ||
        pointInPolygon(x + 0.5, y + 0.5, b);
    })(),
  ],
  [
    "diamonds",
    "uncommon",
    16,
    16,
    0,
    (x, y) => Math.abs(x + 0.5 - 8) + Math.abs(y + 0.5 - 8) < 6.5,
  ],
  [
    "fish_scales",
    "rare",
    16,
    16,
    0,
    (x, y) => {
      // Rows of overlapping half-circle outlines, each row shifted by half.
      const px = x + 0.5;
      const py = y + 0.5;
      // Scales of row k hang below centres (8 * (k % 2) + 16 i, 8 k).
      // The visible scale at a point is the one from the lowest row whose
      // disc covers it (later rows are drawn on top).
      let best = null;
      for (let k = -1; k <= 2; k++) {
        const cy = 8 * k;
        for (let i = -1; i <= 1; i++) {
          const cx = (k % 2 === 0 ? 0 : 8) + 16 * i;
          const d = Math.hypot(px - cx, py - cy);
          if (d < 8.5 && py >= cy) {
            if (best === null || cy > best.cy) best = { cy, d };
          }
        }
      }
      return best !== null && best.d > 7;
    },
  ],
  [
    "tartan",
    "rare",
    24,
    24,
    0,
    (x, y) => {
      const a = x < 5 || x === 13;
      const b = y < 5 || y === 13;
      return a !== b;
    },
  ],
  ["grid", "common", 12, 12, 0, (x, y) => x === 0 || y === 0],
  [
    "labyrinth",
    "epic",
    32,
    32,
    1,
    (() => {
      const rand = prng(0x10f00d);
      const cells = Array.from({ length: 16 }, () => rand() < 0.5);
      return (x, y) => {
        const cx = Math.floor(x / 8);
        const cy = Math.floor(y / 8);
        const lx = (x % 8) + 0.5;
        const ly = (y % 8) + 0.5;
        const d = cells[cy * 4 + cx]
          ? Math.abs(lx - ly) / Math.SQRT2
          : Math.abs(lx + ly - 8) / Math.SQRT2;
        return d < 0.9;
      };
    })(),
  ],
  [
    "ripples",
    "legendary",
    20,
    20,
    0,
    (x, y) => {
      const d = Math.hypot(x + 0.5 - 10, y + 0.5 - 10);
      return d < 2 || (d > 4.5 && d < 6.2) || d > 8.7;
    },
  ],
];

// ---------------------------------------------------------------------------
// Colour palettes

const COLOR_PALETTES = [
  ["crimson_ivory", "#b3122e", "#f4ead5"],
  ["ocean_foam", "#0e4d92", "#9fd8ef"],
  ["forest_moss", "#1f5130", "#a3c45a"],
  ["royal_gold", "#3c1a6e", "#e8b931"],
  ["sunset_coral", "#ff6b4a", "#ffd166"],
  ["arctic_frost", "#d9eefc", "#4a90d9"],
  ["midnight_neon", "#16163a", "#00e5ff"],
  ["desert_sand", "#c2964b", "#f3e3c3"],
  ["cherry_blossom", "#f7c6d9", "#c2185b"],
  ["volcanic_ash", "#2e2e2e", "#ff5722"],
  ["mint_cocoa", "#4e342e", "#98f5c8"],
  ["lavender_sky", "#7e57c2", "#e1d5ff"],
];

const colorPalettes = {};
for (const [name, primaryColor, secondaryColor] of COLOR_PALETTES) {
  colorPalettes[name] = { name, primaryColor, secondaryColor };
}

const patterns = {};
PATTERN_DEFS.forEach(([name, rarity, w, h, scale, fn], i) => {
  // Four palettes per pattern, walking the palette list with a stride so
  // neighbouring patterns get different sets.
  const refs = [];
  for (let k = 0; k < 4; k++) {
    refs.push({
      name: COLOR_PALETTES[(i * 5 + k * 3) % COLOR_PALETTES.length][0],
      isArchived: false,
    });
  }
  patterns[name] = {
    name,
    product: null,
    artist: ARTIST,
    rarity,
    pattern: encodePattern(w, h, scale, fn),
    colorPalettes: refs,
  };
});

// ---------------------------------------------------------------------------
// Skins
//
// A skin is a 1024x1024 image tiled over the owner's whole territory at one
// image pixel per map tile, with the image centre on the owner's spawn tile
// (SkinAtlasArray uploads it into a REPEAT-wrapped atlas layer;
// territory.frag.glsl samples each tile's texel centre). In FFA the skin's own
// colours show; team games multiply them by the team colour.
//
// So every skin here is pixel art on the tile grid: a small seamless tile
// (its size divides 1024, so the 1024 image tiles seamlessly too) drawn as
// crisp axis-aligned runs, repeated with an SVG <pattern>. Each tile pixel is
// one map tile, which keeps the skins sharp at every zoom: no anti-aliased
// half-tones, blur or noise, just a few flat colours per skin. Territory is
// drawn at mapOverlay.territoryAlpha over the terrain, so palettes keep
// strong contrast. Names differ from the patterns' (both share one list).

const SKIN_SIZE = 1024;

/** Positive modulo. */
const mod = (a, n) => ((a % n) + n) % n;

/**
 * Pixel tile helper. `paint(set)` fills a w x h grid of palette indices
 * (index 0 is the background); `set(x, y, i)` wraps around the tile edges,
 * so shapes that cross an edge continue on the opposite side.
 */
function pixelTile(w, h, palette, paint) {
  if (SKIN_SIZE % w !== 0 || SKIN_SIZE % h !== 0) {
    throw new Error(`skin tile ${w}x${h} does not divide ${SKIN_SIZE}`);
  }
  const grid = new Uint8Array(w * h);
  const set = (x, y, i) => {
    grid[mod(Math.round(y), h) * w + mod(Math.round(x), w)] = i;
  };
  const get = (x, y) => grid[mod(y, h) * w + mod(x, w)];
  paint(set, get);
  return { w, h, palette, grid };
}

/** Tile whose every pixel is `f(x, y)`, sampled at the pixel centre. */
function fieldTile(w, h, palette, f) {
  return pixelTile(w, h, palette, (set) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) set(x, y, f(x + 0.5, y + 0.5));
    }
  });
}

function tileToSvg({ w, h, palette, grid }) {
  const runs = palette.map(() => "");
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const i = grid[y * w + x];
      let end = x + 1;
      while (end < w && grid[y * w + end] === i) end++;
      if (i !== 0) runs[i] += `M${x} ${y}h${end - x}v1h${x - end}z`;
      x = end;
    }
  }
  const paths = runs
    .map((d, i) => (d ? `<path fill="${palette[i]}" d="${d}"/>` : ""))
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SKIN_SIZE}" height="${SKIN_SIZE}" viewBox="0 0 ${SKIN_SIZE} ${SKIN_SIZE}" shape-rendering="crispEdges">` +
    `<defs><pattern id="t" width="${w}" height="${h}" patternUnits="userSpaceOnUse">` +
    `<rect width="${w}" height="${h}" fill="${palette[0]}"/>${paths}` +
    `</pattern></defs>` +
    `<rect width="${SKIN_SIZE}" height="${SKIN_SIZE}" fill="url(#t)"/>` +
    `</svg>\n`
  );
}

/**
 * Nearest lattice centre to (x, y) on a w x h torus, and the distance to the
 * edge of its Voronoi cell. `ys` scales the y axis of the metric (a centred
 * rectangular lattice becomes a regular hexagonal one when ys = w*sqrt(3)/h).
 */
function voronoi(x, y, centres, w, h, ys = 1) {
  const pts = [];
  for (const [cx, cy, id] of centres) {
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        pts.push([cx + ox * w, (cy + oy * h) * ys, id]);
      }
    }
  }
  const py = y * ys;
  let best = null;
  let bestD = Infinity;
  for (const p of pts) {
    const d = (p[0] - x) ** 2 + (p[1] - py) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  let edge = Infinity;
  for (const p of pts) {
    if (p === best) continue;
    const sep = Math.hypot(p[0] - best[0], p[1] - best[1]);
    const d = (p[0] - x) ** 2 + (p[1] - py) ** 2;
    edge = Math.min(edge, (d - bestD) / (2 * sep));
  }
  return {
    id: best[2],
    dist: Math.sqrt(bestD),
    edge,
    dx: x - best[0],
    dy: py - best[1],
  };
}

/**
 * Smooth periodic field on a w x h torus in about [-1, 1]: a sum of waves
 * whose frequencies are whole numbers of cycles per tile, so it wraps.
 */
function periodicField(rand, w, h, waves) {
  const terms = [];
  for (const [maxF, amp] of waves) {
    let fx = 0;
    let fy = 0;
    while (fx === 0 && fy === 0) {
      fx = Math.floor(rand() * (2 * maxF + 1)) - maxF;
      fy = Math.floor(rand() * (maxF + 1));
    }
    terms.push({ fx, fy, amp, phase: rand() * Math.PI * 2 });
  }
  const total = terms.reduce((s, t) => s + t.amp, 0);
  return (x, y) => {
    let v = 0;
    for (const t of terms) {
      v +=
        t.amp *
        Math.sin(2 * Math.PI * ((t.fx * x) / w + (t.fy * y) / h) + t.phase);
    }
    return v / total;
  };
}

/** Majority filter (3x3, wrapping): removes single-pixel specks and jags. */
function smoothTile(tile, passes = 1) {
  const { w, h, grid } = tile;
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(grid);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const counts = new Map();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const v = grid[mod(y + dy, h) * w + mod(x + dx, w)];
            counts.set(v, (counts.get(v) ?? 0) + 1);
          }
        }
        let bestV = grid[y * w + x];
        let bestN = counts.get(bestV);
        for (const [v, n] of counts) {
          if (n > bestN) {
            bestN = n;
            bestV = v;
          }
        }
        next[y * w + x] = bestN >= 5 ? bestV : grid[y * w + x];
      }
    }
    grid.set(next);
  }
  return tile;
}

const SQRT3 = Math.sqrt(3);

const SKIN_DEFS = [
  {
    // Amber hexagon cells with a dark wax outline and a light inner bevel.
    name: "beehive",
    rarity: "rare",
    tile() {
      const W = 32;
      const H = 64;
      const ys = (W * SQRT3) / H;
      const centres = [
        [0, 0, 0],
        [W / 2, H / 2, 1],
      ];
      const pal = ["#e9a426", "#7a4a0c", "#f6c85a", "#c98512"];
      return fieldTile(W, H, pal, (x, y) => {
        const v = voronoi(x, y, centres, W, H, ys);
        if (v.edge < 1.1) return 1;
        if (v.edge < 3.2) return v.dy * 0.6 - v.dx < 0 ? 2 : 3;
        return 0;
      });
    },
  },
  {
    // Overlapping scales, each with a dark rim and a light inner crescent.
    name: "dragon_scales",
    rarity: "epic",
    tile() {
      const W = 16;
      const H = 16;
      const R = 8.6;
      const pal = ["#1f7a5c", "#0c3b2e", "#4fbf8f", "#16634a"];
      return fieldTile(W, H, pal, (x, y) => {
        // Rows 8px apart, every other row shifted half a scale; upper rows
        // overlap lower ones, so each scale shows its bottom arc.
        for (let row = -2; row <= 3; row++) {
          const cy = row * 8;
          const cx = mod(row, 2) * 8;
          for (const ox of [-W, 0, W]) {
            const d = Math.hypot(x - (cx + ox), y - cy);
            if (d < R) {
              if (d > R - 1.3) return 1;
              if (d > R - 3 && y > cy + 1) return 2;
              return y < cy - 2 ? 3 : 0;
            }
          }
        }
        return 0;
      });
    },
  },
  {
    // Gold-on-ink nested diamonds with a stepped centre: 1920s geometry.
    name: "art_deco",
    rarity: "legendary",
    tile() {
      const S = 32;
      const pal = ["#10192e", "#d4af37", "#1d2c4d", "#f1d77a"];
      return fieldTile(S, S, pal, (x, y) => {
        // Diamond lattice: centres at (0,0) and (16,16) on the torus.
        const dx1 = Math.abs(mod(x, S) - S / 2);
        const dy1 = Math.abs(mod(y, S) - S / 2);
        const dA = dx1 + dy1; // L1 distance to (16,16)
        const dB = S / 2 - dx1 + (S / 2 - dy1); // to the (0,0) corners
        const d = Math.min(dA, dB);
        const ring = Math.floor(d);
        if (ring === 15 || ring === 16) return 1; // outline between diamonds
        if (ring === 11) return 1;
        if (ring >= 12 && ring <= 14) return 2;
        if (ring === 7) return 1;
        if (ring <= 3) return 3;
        return 0;
      });
    },
  },
  {
    // Rolling waves in three blues with a crisp foam line on each crest.
    name: "tidal_waves",
    rarity: "uncommon",
    tile() {
      const W = 64;
      const H = 32;
      const bands = ["#0b4a74", "#1272a6", "#0e5e8d", "#1b88c0"];
      const pal = [...bands, "#d6f1ff"];
      const wave = (x) =>
        Math.round(3 * Math.sin((2 * Math.PI * (mod(x, W) + 0.5)) / W));
      return pixelTile(W, H, pal, (set) => {
        for (let x = 0; x < W; x++) {
          for (let y = 0; y < H; y++) {
            set(x, y, Math.floor(mod(y + wave(x), H) / 8));
          }
          // Foam on each crest, joined vertically where the crest steps.
          const a = wave(x);
          const b = wave(x + 1);
          for (let band = 0; band < H; band += 8) {
            set(x, band - a, 4);
            set(x, band - b, 4);
          }
        }
      });
    },
  },
  {
    // 2x2 twill weave: tows alternate direction along diagonals.
    name: "carbon_fiber",
    rarity: "epic",
    tile() {
      const B = 4;
      const S = 16;
      const pal = ["#24262b", "#121316", "#3a3d44", "#4f535c"];
      return fieldTile(S, S, pal, (x, y) => {
        const bx = Math.floor(x / B);
        const by = Math.floor(y / B);
        const horizontal = mod(bx - by, 4) < 2;
        const t = horizontal ? Math.floor(y) % B : Math.floor(x) % B;
        return [1, 0, 3, 2][t];
      });
    },
  },
  {
    // Oak parquet: 16x4 planks in herringbone, three wood tones, 1px joints.
    name: "herringbone",
    rarity: "uncommon",
    tile() {
      const L = 16;
      const PW = 4;
      const S = 32;
      const pal = ["#a8692f", "#45260f", "#c98a4b", "#8a5424"];
      // Plank pairs sit on the lattice (PW,PW)*m + (L,-L)*n, which contains
      // the tile's own translations (32,0) = 4a+b and (0,32) = 4a-b.
      const tones = [0, 2, 3, 0, 3, 2, 0, 2];
      return pixelTile(S, S, pal, (set) => {
        const plank = (x0, y0, w, h, tone) => {
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              set(x0 + x, y0 + y, x === w - 1 || y === h - 1 ? 1 : tone);
            }
          }
        };
        // The 32x32 tile holds exactly the 8 plank pairs m = 0..7.
        for (let m = 0; m < 8; m++) {
          const o = m * PW;
          plank(o, o, L, PW, tones[m]);
          plank(o + L, o + PW - L, PW, L, tones[mod(m + 3, 8)]);
        }
      });
    },
  },
  {
    // Gold traces at 0/45/90 degrees ending in pads, on a dark green board.
    name: "circuit_board",
    rarity: "epic",
    tile() {
      const S = 64;
      const pal = ["#0f3d2e", "#d9a73e", "#145440", "#0a2a20"];
      const rand = prng(0xc1c0);
      return pixelTile(S, S, pal, (set, get) => {
        // Faint board grid every 8px.
        for (let i = 0; i < S; i++) {
          for (let k = 0; k < S; k += 8) {
            set(i, k, 2);
            set(k, i, 2);
          }
        }
        const used = new Set();
        const key = (x, y) => `${mod(x, S)},${mod(y, S)}`;
        const free = (x, y) => {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (used.has(key(x + dx, y + dy))) return false;
            }
          }
          return true;
        };
        const pad = (x, y) => {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              set(x + dx, y + dy, dx === 0 && dy === 0 ? 3 : 1);
              used.add(key(x + dx, y + dy));
            }
          }
        };
        const dirs = [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ];
        let placed = 0;
        for (let attempt = 0; attempt < 400 && placed < 14; attempt++) {
          let x = 4 + 8 * Math.floor(rand() * 8);
          let y = 4 + 8 * Math.floor(rand() * 8);
          if (!free(x, y) || !free(x + 1, y + 1)) continue;
          // Path: straight run, a 45-degree jog, another straight run.
          const [dx, dy] = dirs[Math.floor(rand() * 4)];
          const turn = rand() < 0.5 ? 1 : -1;
          const jx = dx === 0 ? turn : dx;
          const jy = dy === 0 ? turn : dy;
          const legs = [
            [dx, dy, 4 + Math.floor(rand() * 8)],
            [jx, jy, 2 + Math.floor(rand() * 5)],
            [dx, dy, 3 + Math.floor(rand() * 8)],
          ];
          const cells = [];
          let ok = true;
          let cx = x;
          let cy = y;
          for (const [sx, sy, n] of legs) {
            for (let i = 0; i < n; i++) {
              cx += sx;
              cy += sy;
              cells.push([cx, cy]);
            }
          }
          // Keep clear of other traces (but not of our own previous cell).
          for (let i = 2; i < cells.length; i++) {
            if (!free(cells[i][0], cells[i][1])) ok = false;
          }
          const [ex, ey] = cells[cells.length - 1];
          if (!ok || !free(ex + 1, ey) || !free(ex, ey + 1)) continue;
          pad(x, y);
          for (const [px, py] of cells) set(px, py, 1);
          for (const [px, py] of cells) used.add(key(px, py));
          pad(ex, ey);
          placed++;
        }
        // Lone vias in the gaps.
        for (let i = 0; i < 10; i++) {
          const x = 4 + 8 * Math.floor(rand() * 8);
          const y = 4 + 8 * Math.floor(rand() * 8);
          if (free(x, y) && get(x, y) === 0) pad(x, y);
        }
      });
    },
  },
  {
    // Contour map: flat teal-to-cream hypsometric bands with crisp 1px contour lines.
    name: "topography",
    rarity: "rare",
    tile() {
      const S = 128;
      const pal = [
        "#1b4b5a",
        "#2b6a74",
        "#44898a",
        "#6fa99c",
        "#a3c8ac",
        "#dbe7c3",
        "#0c2a33",
      ];
      const h = periodicField(prng(0x70f0), S, S, [
        [2, 1],
        [2, 0.8],
        [3, 0.55],
        [3, 0.45],
        [4, 0.25],
      ]);
      // Ten levels spread over the field's actual range; the six fills go
      // up then back down the ramp so neighbouring bands always differ.
      let lo = Infinity;
      let hi = -Infinity;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const v = h(x + 0.5, y + 0.5);
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      const BANDS = 10;
      const fill = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1];
      const levels = pixelTile(S, S, [], (set) => {
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const t = (h(x + 0.5, y + 0.5) - lo) / (hi - lo);
            set(x, y, Math.min(BANDS - 1, Math.floor(t * BANDS)));
          }
        }
      });
      smoothTile(levels, 2);
      const lv = (x, y) => levels.grid[mod(y, S) * S + mod(x, S)];
      // A 1px contour on the low side of every band edge.
      const tile = fieldTile(S, S, pal, (fx, fy) => {
        const x = Math.floor(fx);
        const y = Math.floor(fy);
        const l = lv(x, y);
        const higher =
          l < lv(x + 1, y) ||
          l < lv(x - 1, y) ||
          l < lv(x, y + 1) ||
          l < lv(x, y - 1);
        return higher ? 6 : fill[l];
      });
      return tile;
    },
  },
  {
    // Flat four-colour woodland camouflage with smooth-edged blobs.
    name: "woodland_camo",
    rarity: "rare",
    tile() {
      const S = 128;
      const pal = ["#556b2f", "#a0a862", "#6b4728", "#17180f"];
      const rand = prng(0xca30);
      const waves = [
        [3, 1],
        [4, 0.8],
        [5, 0.6],
        [6, 0.35],
      ];
      const a = periodicField(rand, S, S, waves);
      const b = periodicField(rand, S, S, waves);
      const c = periodicField(rand, S, S, waves);
      return smoothTile(
        fieldTile(S, S, pal, (x, y) => {
          if (c(x, y) > 0.42) return 3;
          if (b(x, y) > 0.25) return 2;
          return a(x, y) > 0.05 ? 1 : 0;
        }),
        3,
      );
    },
  },
  {
    // Red tartan: a mirrored sett woven as a 2/2 twill.
    name: "royal_tartan",
    rarity: "rare",
    tile() {
      const pal = ["#a3202e", "#1c2a4a", "#1e5b3a", "#e8c547", "#f2efe6"];
      // [palette index, threads]; mirrored about its ends -> 64 threads.
      const half = [
        [0, 12],
        [1, 6],
        [0, 2],
        [4, 1],
        [0, 2],
        [2, 6],
        [3, 1],
        [2, 2],
      ];
      const sett = [];
      for (const [c, n] of half) for (let i = 0; i < n; i++) sett.push(c);
      const threads = [...sett, ...sett.slice().reverse()];
      const S = threads.length;
      return fieldTile(S, S, pal, (x, y) => {
        const warp = threads[Math.floor(x)];
        const weft = threads[Math.floor(y)];
        if (warp === weft) return warp;
        // Different threads cross: the 2/2 twill shows each in turn.
        return mod(Math.floor(x) + Math.floor(y), 4) < 2 ? warp : weft;
      });
    },
  },
];

for (const d of SKIN_DEFS) {
  const tile = d.tile();
  d.svg = () => tileToSvg(tile);
}

// ---------------------------------------------------------------------------
// Crowns
//
// A crown replaces the first-place crown icon drawn next to the leader's
// name (name-pass StatusIconProgram slot 0): the image is drawn into a
// 128x128 cell of the crown atlas, so every crown is a square 128x128 SVG
// with a transparent background.

function crownSvg(defs, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
    `<defs>${defs}</defs>${body}</svg>\n`
  );
}
const metal = (id, a, b, c) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="0.55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>`;
const gem = (cx, cy, rr, fill) =>
  `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${fill}" stroke="#1f1300" stroke-opacity="0.5" stroke-width="2"/><circle cx="${cx - rr / 3}" cy="${cy - rr / 3}" r="${rr / 3}" fill="#fff" fill-opacity="0.7"/>`;

const CROWN_DEFS = [
  {
    name: "golden_crown",
    rarity: "common",
    svg: () =>
      crownSvg(
        metal("g", "#fff1a8", "#f5b700", "#a86b00"),
        `<path d="M14 98 L8 36 L38 62 L64 22 L90 62 L120 36 L114 98 Z" fill="url(#g)" stroke="#6b4200" stroke-width="4" stroke-linejoin="round"/>` +
          `<rect x="12" y="96" width="104" height="16" rx="4" fill="url(#g)" stroke="#6b4200" stroke-width="4"/>` +
          gem(64, 74, 9, "#dc2626") +
          gem(34, 82, 6, "#2563eb") +
          gem(94, 82, 6, "#2563eb") +
          `<circle cx="8" cy="34" r="6" fill="#fff1a8" stroke="#6b4200" stroke-width="3"/><circle cx="64" cy="20" r="7" fill="#fff1a8" stroke="#6b4200" stroke-width="3"/><circle cx="120" cy="34" r="6" fill="#fff1a8" stroke="#6b4200" stroke-width="3"/>`,
      ),
  },
  {
    name: "silver_laurel",
    rarity: "uncommon",
    svg: () => {
      let leaves = "";
      for (let i = 0; i < 7; i++) {
        const t = i / 6;
        const a = Math.PI * (0.95 - t * 0.75);
        for (const side of [-1, 1]) {
          const cx = 64 + side * 44 * Math.cos(a);
          const cy = 70 + 40 * Math.sin(a) - 10;
          const rot =
            side * ((a * 180) / Math.PI) + (side < 0 ? 180 : 0) + 90 * side;
          leaves += `<ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="13" ry="6" transform="rotate(${r1(rot)} ${r1(cx)} ${r1(cy)})" fill="url(#s)" stroke="#475569" stroke-width="2"/>`;
        }
      }
      return crownSvg(
        metal("s", "#ffffff", "#cbd5e1", "#64748b"),
        `<path d="M24 104 Q64 124 104 104" fill="none" stroke="#64748b" stroke-width="5" stroke-linecap="round"/>${leaves}` +
          gem(64, 108, 7, "#60a5fa"),
      );
    },
  },
  {
    name: "ruby_tiara",
    rarity: "rare",
    svg: () =>
      crownSvg(
        metal("t", "#fde68a", "#e5a50a", "#92400e"),
        `<path d="M10 104 Q64 18 118 104 Q64 82 10 104 Z" fill="url(#t)" stroke="#7c2d12" stroke-width="4" stroke-linejoin="round"/>` +
          `<path d="M28 94 Q64 52 100 94" fill="none" stroke="#fff7d6" stroke-opacity="0.7" stroke-width="3"/>` +
          `<path d="M64 26 L78 52 L64 70 L50 52 Z" fill="#e11d48" stroke="#7c2d12" stroke-width="3" stroke-linejoin="round"/>` +
          `<path d="M64 30 L72 50 L64 52 Z" fill="#fff" fill-opacity="0.55"/>` +
          gem(36, 84, 5, "#f43f5e") +
          gem(92, 84, 5, "#f43f5e"),
      ),
  },
  {
    name: "frost_crown",
    rarity: "epic",
    svg: () =>
      crownSvg(
        metal("f", "#f0fdff", "#7dd3fc", "#0369a1"),
        `<path d="M12 100 L18 50 L30 72 L40 18 L52 66 L64 8 L76 66 L88 18 L98 72 L110 50 L116 100 Z" fill="url(#f)" stroke="#0c4a6e" stroke-width="4" stroke-linejoin="round"/>` +
          `<rect x="10" y="96" width="108" height="16" rx="5" fill="url(#f)" stroke="#0c4a6e" stroke-width="4"/>` +
          `<path d="M40 26 L44 60 M64 18 L64 62 M88 26 L84 60" stroke="#ffffff" stroke-opacity="0.8" stroke-width="3" stroke-linecap="round"/>` +
          gem(64, 104, 5, "#e0f2fe") +
          gem(36, 104, 4, "#bae6fd") +
          gem(92, 104, 4, "#bae6fd"),
      ),
  },
  {
    name: "ember_crown",
    rarity: "legendary",
    svg: () =>
      crownSvg(
        metal("e", "#fff7b0", "#fb923c", "#b91c1c") +
          metal("eb", "#57534e", "#292524", "#0c0a09"),
        `<path d="M16 96 C10 70 26 64 24 42 C38 54 40 66 42 74 C44 50 54 34 52 12 C70 30 72 52 70 70 C76 58 84 50 84 30 C98 46 100 62 96 74 C104 66 108 58 108 46 C120 64 116 84 112 96 Z" fill="url(#e)" stroke="#7f1d1d" stroke-width="3.5" stroke-linejoin="round"/>` +
          `<rect x="12" y="94" width="104" height="18" rx="5" fill="url(#eb)" stroke="#0c0a09" stroke-width="3"/>` +
          gem(64, 103, 6, "#f97316") +
          gem(36, 103, 4.5, "#fbbf24") +
          gem(92, 103, 4.5, "#fbbf24"),
      ),
  },
  {
    name: "star_circlet",
    rarity: "epic",
    svg: () => {
      const star = (cx, cy, R, rr) =>
        starPolygon(cx, cy, R, rr)
          .map(([x, y], i) => `${i === 0 ? "M" : "L"}${r1(x)} ${r1(y)}`)
          .join("") + "Z";
      return crownSvg(
        metal("p", "#e9d5ff", "#a855f7", "#581c87") +
          metal("y", "#fffbeb", "#fcd34d", "#d97706"),
        `<path d="M14 92 Q64 70 114 92 L114 108 Q64 88 14 108 Z" fill="url(#p)" stroke="#3b0764" stroke-width="4" stroke-linejoin="round"/>` +
          `<path d="${star(64, 46, 30, 12)}" fill="url(#y)" stroke="#92400e" stroke-width="3.5" stroke-linejoin="round"/>` +
          `<path d="${star(28, 68, 16, 6.5)}" fill="url(#y)" stroke="#92400e" stroke-width="3" stroke-linejoin="round"/>` +
          `<path d="${star(100, 68, 16, 6.5)}" fill="url(#y)" stroke="#92400e" stroke-width="3" stroke-linejoin="round"/>` +
          gem(64, 94, 5, "#f0abfc"),
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Effects: a few variants per effect type, attributes per CosmeticSchemas.ts.

const RAINBOW = [
  "#ff3b30",
  "#ff9500",
  "#ffcc00",
  "#34c759",
  "#00c7be",
  "#007aff",
  "#af52de",
];

const EFFECT_DEFS = {
  transportShipTrail: [
    [
      "sea_foam",
      "common",
      {
        type: "gradient",
        colors: ["#e0f7ff", "#7fd6ff", "#2a8cff"],
        colorSize: 4,
        movementSpeed: 8,
      },
    ],
    [
      "sunset_wake",
      "uncommon",
      {
        type: "gradient",
        colors: ["#ff5e62", "#ff9966", "#ffd86f"],
        colorSize: 5,
        movementSpeed: 10,
      },
    ],
    [
      "neon_pulse",
      "rare",
      {
        type: "transition",
        colors: ["#ff2bd6", "#00e5ff", "#a6ff00"],
        frequency: 1.5,
      },
    ],
    [
      "prism_wake",
      "epic",
      { type: "gradient", colors: RAINBOW, colorSize: 3, movementSpeed: 14 },
    ],
  ],
  nukeTrail: [
    [
      "toxic_glow",
      "uncommon",
      {
        type: "gradient",
        colors: ["#d9f99d", "#84cc16", "#365314"],
        colorSize: 4,
        movementSpeed: 12,
      },
    ],
    [
      "warning_lights",
      "rare",
      { type: "transition", colors: ["#ef4444", "#facc15"], frequency: 3 },
    ],
    [
      "double_helix",
      "epic",
      {
        type: "spiral",
        colors: ["#38bdf8", "#f472b6"],
        radius: 6,
        strands: 2,
        rotationSpeed: 5,
      },
    ],
    [
      "vortex",
      "legendary",
      {
        type: "spiral",
        colors: ["#a855f7", "#22d3ee", "#ffffff"],
        radius: 8,
        strands: 4,
        rotationSpeed: 7,
      },
    ],
  ],
  nukeExplosion: [
    [
      "solar_flare",
      "rare",
      {
        type: "shockwave",
        nukeType: "atom",
        colors: ["#fff7d6", "#fbbf24", "#f97316", "#b91c1c"],
        size: 200,
        speed: 140,
        thickness: 5,
        transitionSpeed: 2,
      },
    ],
    [
      "starburst",
      "epic",
      {
        type: "sparkles",
        nukeType: "atom",
        colors: ["#ffffff", "#fde68a", "#93c5fd"],
        size: 190,
        speed: 120,
        thickness: 3,
        transitionSpeed: 3,
        density: 300,
      },
    ],
    [
      "cinder_bloom",
      "uncommon",
      {
        type: "embers",
        nukeType: "atom",
        colors: ["#fef3c7", "#fb923c", "#dc2626", "#451a03"],
        size: 180,
        speed: 110,
        thickness: 3,
        transitionSpeed: 1.5,
        density: 260,
      },
    ],
    [
      "tidal_ring",
      "rare",
      {
        type: "shockwave",
        nukeType: "hydro",
        colors: ["#ecfeff", "#67e8f9", "#0891b2", "#1e3a8a"],
        size: 420,
        speed: 220,
        thickness: 8,
        transitionSpeed: 1.5,
      },
    ],
    [
      "glitter_storm",
      "legendary",
      {
        type: "sparkles",
        nukeType: "hydro",
        colors: ["#f0abfc", "#a78bfa", "#67e8f9", "#ffffff"],
        size: 400,
        speed: 200,
        thickness: 4,
        transitionSpeed: 4,
        density: 450,
      },
    ],
    [
      "magma_rain",
      "epic",
      {
        type: "embers",
        nukeType: "hydro",
        colors: ["#fde047", "#f97316", "#b91c1c", "#292524"],
        size: 380,
        speed: 180,
        thickness: 4,
        transitionSpeed: 2,
        density: 400,
      },
    ],
    [
      "split_halo",
      "uncommon",
      {
        type: "shockwave",
        nukeType: "mirvWarhead",
        colors: ["#ffffff", "#a5b4fc", "#6366f1"],
        size: 70,
        speed: 90,
        thickness: 3,
        transitionSpeed: 3,
      },
    ],
    [
      "confetti_pop",
      "rare",
      {
        type: "sparkles",
        nukeType: "mirvWarhead",
        colors: ["#f43f5e", "#facc15", "#22c55e", "#3b82f6"],
        size: 70,
        speed: 80,
        thickness: 2.5,
        transitionSpeed: 5,
        density: 120,
      },
    ],
    [
      "spark_shower",
      "common",
      {
        type: "embers",
        nukeType: "mirvWarhead",
        colors: ["#fff7ed", "#fdba74", "#ea580c"],
        size: 60,
        speed: 70,
        thickness: 2,
        transitionSpeed: 2,
        density: 110,
      },
    ],
  ],
  structures: [
    [
      "gilded",
      "rare",
      {
        type: "gradient",
        colors: ["#fff1a8", "#f5b700", "#a86b00"],
        colorSize: 4,
        movementSpeed: 6,
      },
    ],
    [
      "chameleon",
      "epic",
      {
        type: "transition",
        colors: ["#22c55e", "#06b6d4", "#a855f7", "#f43f5e"],
        frequency: 0.8,
      },
    ],
    [
      "frostbite",
      "uncommon",
      {
        type: "gradient",
        colors: ["#f0f9ff", "#7dd3fc", "#0284c7"],
        colorSize: 3,
        movementSpeed: 4,
      },
    ],
  ],
  warship: [
    [
      "steel_tide",
      "uncommon",
      {
        type: "gradient",
        colors: ["#e2e8f0", "#64748b", "#1e293b"],
        colorSize: 4,
        movementSpeed: 8,
      },
    ],
    [
      "phantom",
      "epic",
      { type: "transition", colors: ["#a78bfa", "#1e1b4b"], frequency: 1 },
    ],
    [
      "crimson_fleet",
      "rare",
      {
        type: "gradient",
        colors: ["#fecaca", "#dc2626", "#450a0a"],
        colorSize: 3,
        movementSpeed: 10,
      },
    ],
  ],
  train: [
    [
      "golden_express",
      "rare",
      {
        type: "gradient",
        colors: ["#fde68a", "#d97706", "#78350f"],
        colorSize: 4,
        movementSpeed: 10,
      },
    ],
    [
      "neon_line",
      "epic",
      {
        type: "transition",
        colors: ["#f0abfc", "#22d3ee", "#a3e635"],
        frequency: 2,
      },
    ],
    [
      "midnight_run",
      "uncommon",
      {
        type: "gradient",
        colors: ["#312e81", "#6366f1", "#c7d2fe"],
        colorSize: 5,
        movementSpeed: 8,
      },
    ],
  ],
  railroad: [
    [
      "copper_rails",
      "uncommon",
      {
        type: "gradient",
        colors: ["#fdba74", "#c2410c", "#7c2d12"],
        colorSize: 6,
        movementSpeed: 0,
      },
    ],
    [
      "glow_track",
      "rare",
      {
        type: "gradient",
        colors: ["#34d399", "#22d3ee", "#818cf8"],
        colorSize: 5,
        movementSpeed: 6,
      },
    ],
    [
      "candy_stripe",
      "epic",
      {
        type: "gradient",
        colors: ["#ffffff", "#ef4444"],
        colorSize: 2,
        movementSpeed: 3,
      },
    ],
  ],
};

const effects = {};
for (const [effectType, list] of Object.entries(EFFECT_DEFS)) {
  effects[effectType] = {};
  for (const [name, rarity, attributes] of list) {
    effects[effectType][name] = {
      name,
      product: null,
      artist: ARTIST,
      rarity,
      effectType,
      attributes,
    };
  }
}

// ---------------------------------------------------------------------------
// Flags (unchanged behaviour)

const countries = JSON.parse(
  fs.readFileSync(path.join(root, "resources/countries.json"), "utf8"),
);
const countryCodes = new Set(countries.map((c) => c.code));

const flags = {};
const taken = new Set();
const flagFiles = fs
  .readdirSync(path.join(root, "resources/flags"))
  .filter((f) => f.endsWith(".svg"))
  .map((f) => f.slice(0, -".svg".length))
  .filter((code) => !countryCodes.has(code))
  .sort();
for (const code of flagFiles) {
  let name = slug(code) === "" ? "flag" : slug(code);
  for (let i = 2; taken.has(name); i++) {
    name = `${slug(code).slice(0, 29)}_${i}`;
  }
  taken.add(name);
  flags[name] = {
    name,
    product: null,
    rarity: "common",
    url: `/flags/${encodeURIComponent(code)}.svg`,
  };
}

// ---------------------------------------------------------------------------
// Write artwork + catalog

function writeArtDir(dir, defs) {
  fs.mkdirSync(dir, { recursive: true });
  const wanted = new Set(defs.map((d) => `${d.name}.svg`));
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".svg") && !wanted.has(f)) fs.rmSync(path.join(dir, f));
  }
  for (const d of defs)
    fs.writeFileSync(path.join(dir, `${d.name}.svg`), d.svg());
}

writeArtDir(skinsDir, SKIN_DEFS);
writeArtDir(crownsDir, CROWN_DEFS);

const skins = {};
for (const d of SKIN_DEFS) {
  skins[d.name] = {
    name: d.name,
    product: null,
    artist: ARTIST,
    rarity: d.rarity,
    url: `/cosmetics/skins/${d.name}.svg`,
  };
}
const crowns = {};
for (const d of CROWN_DEFS) {
  crowns[d.name] = {
    name: d.name,
    product: null,
    artist: ARTIST,
    rarity: d.rarity,
    url: `/cosmetics/crowns/${d.name}.svg`,
  };
}

const existing = fs.existsSync(catalogPath)
  ? JSON.parse(fs.readFileSync(catalogPath, "utf8"))
  : {};

const catalog = {
  ...existing,
  colorPalettes,
  patterns,
  flags,
  crowns,
  skins,
  effects,
};
fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
const effectCount = Object.values(effects).reduce(
  (n, byName) => n + Object.keys(byName).length,
  0,
);
console.log(
  `Wrote ${catalogPath}: ${Object.keys(colorPalettes).length} palettes, ` +
    `${Object.keys(patterns).length} patterns, ${Object.keys(flags).length} flags, ` +
    `${Object.keys(skins).length} skins, ${Object.keys(crowns).length} crowns, ` +
    `${effectCount} effects`,
);
