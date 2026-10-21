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

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  const c = (v) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mixHex(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}
function shadeHex(hex, f) {
  return rgbToHex(hexToRgb(hex).map((v) => (f >= 0 ? v + (255 - v) * f : v * (1 + f))));
}

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
  [
    "chevrons",
    "uncommon",
    16,
    16,
    0,
    (x, y) => (y + Math.abs(x - 8)) % 16 < 5,
  ],
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
// A skin is one image stamped over the owner's territory, centred on their
// spawn tile, at one image pixel per map tile (see SkinAtlasArray: every
// image is drawn into a 1024x1024 atlas layer, centred, downscaled if larger
// and never upscaled; territory.frag.glsl). It does not tile: tiles outside
// the image -- or where it is transparent -- show the plain player colour. In
// FFA the skin's own colours show; team games multiply them by the team
// colour. So every skin is a full 1024x1024 SVG whose edge fades out (a
// radial mask) into the player colour instead of ending on a hard square.

const SKIN_SIZE = 1024;
const C = SKIN_SIZE / 2;

function skinSvg(defs, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SKIN_SIZE}" height="${SKIN_SIZE}" viewBox="0 0 ${SKIN_SIZE} ${SKIN_SIZE}">` +
    `<defs>` +
    `<radialGradient id="fade" cx="0.5" cy="0.5" r="0.5"><stop offset="0.78" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>` +
    `<mask id="edge"><rect width="${SKIN_SIZE}" height="${SKIN_SIZE}" fill="url(#fade)"/></mask>` +
    defs +
    `</defs>` +
    `<g mask="url(#edge)">${body}</g>` +
    `</svg>\n`
  );
}

/** A closed loop around the centre with a smoothly wobbling radius. */
function wobblyRing(rand, radius, wobble, points = 96) {
  const harmonics = [2, 3, 5, 7].map((k) => ({
    k,
    phase: rand() * Math.PI * 2,
    amp: (rand() * 0.6 + 0.4) / k,
  }));
  let d = "";
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    let rr = radius;
    for (const h of harmonics) rr += wobble * h.amp * Math.sin(h.k * a + h.phase);
    const x = C + rr * Math.cos(a);
    const y = C + rr * Math.sin(a);
    d += `${i === 0 ? "M" : "L"}${r1(x)} ${r1(y)}`;
  }
  return d + "Z";
}

function stars(rand, count, colors, maxR) {
  let out = "";
  for (let i = 0; i < count; i++) {
    const x = rand() * SKIN_SIZE;
    const y = rand() * SKIN_SIZE;
    const rr = 0.8 + rand() * rand() * maxR;
    const col = colors[Math.floor(rand() * colors.length)];
    out += `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(rr)}" fill="${col}"/>`;
  }
  return out;
}

const SKIN_DEFS = [
  {
    name: "aurora",
    rarity: "epic",
    svg() {
      const rand = prng(101);
      let body =
        `<rect width="1024" height="1024" fill="url(#sky)"/>` +
        stars(rand, 260, ["#ffffff", "#cfe8ff"], 1.6);
      const bands = ["#3dffb0", "#22d3a6", "#7c5cff", "#38bdf8", "#a3ff7a"];
      let paths = "";
      for (let b = 0; b < 9; b++) {
        const base = 180 + b * 80 + rand() * 30;
        const amp = 40 + rand() * 60;
        const freq = 1 + Math.floor(rand() * 3);
        const phase = rand() * Math.PI * 2;
        let d = "";
        for (let x = -20; x <= 1044; x += 16) {
          const y =
            base +
            amp * Math.sin((x / 1024) * Math.PI * 2 * freq + phase) +
            0.35 * amp * Math.sin((x / 1024) * Math.PI * 7 + phase * 2);
          d += `${x === -20 ? "M" : "L"}${x} ${r1(y)}`;
        }
        const col = bands[b % bands.length];
        const width = 18 + rand() * 40;
        paths += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${r1(width)}" stroke-opacity="${r1(0.35 + rand() * 0.4)}" stroke-linecap="round"/>`;
      }
      body += `<g filter="url(#glow)">${paths}</g>`;
      return skinSvg(
        `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#050b24"/><stop offset="0.55" stop-color="#0b2a4a"/><stop offset="1" stop-color="#06372f"/></linearGradient>` +
          `<filter id="glow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="10"/></filter>`,
        body,
      );
    },
  },
  {
    name: "sunburst",
    rarity: "uncommon",
    svg() {
      const rays = 28;
      let body = `<rect width="1024" height="1024" fill="#f59e0b"/>`;
      for (let i = 0; i < rays; i += 2) {
        const a0 = (i / rays) * Math.PI * 2;
        const a1 = ((i + 1) / rays) * Math.PI * 2;
        const R = 800;
        body += `<path d="M${C} ${C}L${r1(C + R * Math.cos(a0))} ${r1(C + R * Math.sin(a0))}L${r1(C + R * Math.cos(a1))} ${r1(C + R * Math.sin(a1))}Z" fill="#fcd34d"/>`;
      }
      body += `<rect width="1024" height="1024" fill="url(#heat)"/>`;
      body += `<circle cx="${C}" cy="${C}" r="70" fill="#fff7d6"/><circle cx="${C}" cy="${C}" r="70" fill="none" stroke="#fbbf24" stroke-width="10"/>`;
      return skinSvg(
        `<radialGradient id="heat" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff3c4" stop-opacity="0.7"/><stop offset="0.35" stop-color="#fff3c4" stop-opacity="0"/><stop offset="1" stop-color="#b45309" stop-opacity="0.55"/></radialGradient>`,
        body,
      );
    },
  },
  {
    name: "crystal_facets",
    rarity: "rare",
    svg() {
      const rand = prng(202);
      const N = 16;
      const cell = SKIN_SIZE / N;
      const pts = [];
      for (let j = 0; j <= N; j++) {
        const row = [];
        for (let i = 0; i <= N; i++) {
          const edge = i === 0 || j === 0 || i === N || j === N;
          row.push([
            i * cell + (edge ? 0 : (rand() - 0.5) * cell * 0.8),
            j * cell + (edge ? 0 : (rand() - 0.5) * cell * 0.8),
          ]);
        }
        pts.push(row);
      }
      const from = "#1e3a8a";
      const to = "#06b6d4";
      let body = "";
      const tri = (a, b, c) => {
        const cx = (a[0] + b[0] + c[0]) / 3;
        const cy = (a[1] + b[1] + c[1]) / 3;
        const t = Math.min(1, Math.max(0, (cx + cy) / (2 * SKIN_SIZE)));
        const col = shadeHex(mixHex(from, to, t), (rand() - 0.5) * 0.35);
        body += `<path d="M${r1(a[0])} ${r1(a[1])}L${r1(b[0])} ${r1(b[1])}L${r1(c[0])} ${r1(c[1])}Z" fill="${col}" stroke="${col}" stroke-width="1"/>`;
      };
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const p00 = pts[j][i];
          const p10 = pts[j][i + 1];
          const p01 = pts[j + 1][i];
          const p11 = pts[j + 1][i + 1];
          if ((i + j) % 2 === 0) {
            tri(p00, p10, p11);
            tri(p00, p11, p01);
          } else {
            tri(p00, p10, p01);
            tri(p10, p11, p01);
          }
        }
      }
      return skinSvg("", body);
    },
  },
  {
    name: "topography",
    rarity: "rare",
    svg() {
      const rand = prng(303);
      const ramp = [
        "#2f5d50",
        "#3f7a57",
        "#5f9a5a",
        "#8fb465",
        "#c3c97a",
        "#dcc68c",
        "#c9a271",
        "#a87d5a",
        "#8c6650",
        "#efe9dc",
      ];
      let body = `<rect width="1024" height="1024" fill="${ramp[0]}"/>`;
      const levels = 18;
      for (let l = 0; l < levels; l++) {
        const radius = 740 - l * 40;
        const col = ramp[Math.min(ramp.length - 1, Math.floor((l / levels) * ramp.length) + 1)];
        body += `<path d="${wobblyRing(rand, radius, 90)}" fill="${col}" stroke="#2b2118" stroke-opacity="0.45" stroke-width="2.5"/>`;
      }
      return skinSvg("", body);
    },
  },
  {
    name: "nebula",
    rarity: "legendary",
    svg() {
      const rand = prng(404);
      const body =
        `<rect width="1024" height="1024" fill="#070617"/>` +
        `<rect width="1024" height="1024" filter="url(#clouds)"/>` +
        stars(rand, 420, ["#ffffff", "#ffe4f7", "#d6e6ff"], 2.2);
      return skinSvg(
        `<filter id="clouds" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
          `<feTurbulence type="fractalNoise" baseFrequency="0.0035" numOctaves="5" seed="7"/>` +
          `<feColorMatrix type="matrix" values="1.6 0 0.4 0 -0.35  0.2 0.3 0.6 0 -0.2  0.6 0.4 1.6 0 -0.3  1.4 0 0.6 0 -0.45"/>` +
          `</filter>`,
        body,
      );
    },
  },
  {
    name: "marble",
    rarity: "epic",
    svg() {
      return skinSvg(
        `<filter id="veins" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
          `<feTurbulence type="turbulence" baseFrequency="0.0028 0.0065" numOctaves="5" seed="12"/>` +
          `<feColorMatrix type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1"/>` +
          `<feComponentTransfer>` +
          `<feFuncR type="table" tableValues="0.42 0.78 0.9 0.94 0.96 0.97"/>` +
          `<feFuncG type="table" tableValues="0.40 0.76 0.88 0.92 0.94 0.95"/>` +
          `<feFuncB type="table" tableValues="0.38 0.72 0.84 0.88 0.9 0.91"/>` +
          `</feComponentTransfer>` +
          `</filter>`,
        `<rect width="1024" height="1024" filter="url(#veins)"/>`,
      );
    },
  },
  {
    name: "magma",
    rarity: "legendary",
    svg() {
      return skinSvg(
        `<filter id="lava" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
          `<feTurbulence type="fractalNoise" baseFrequency="0.006" numOctaves="4" seed="21"/>` +
          `<feColorMatrix type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1"/>` +
          `<feComponentTransfer>` +
          `<feFuncR type="table" tableValues="0.08 0.12 0.2 0.75 1 1"/>` +
          `<feFuncG type="table" tableValues="0.04 0.05 0.06 0.2 0.6 0.95"/>` +
          `<feFuncB type="table" tableValues="0.05 0.05 0.05 0.04 0.1 0.5"/>` +
          `</feComponentTransfer>` +
          `</filter>`,
        `<rect width="1024" height="1024" filter="url(#lava)"/>`,
      );
    },
  },
  {
    name: "tidal_waves",
    rarity: "uncommon",
    svg() {
      const rand = prng(505);
      let body = `<rect width="1024" height="1024" fill="#0c4a6e"/>`;
      const rows = 26;
      for (let rI = 0; rI < rows; rI++) {
        const base = rI * 42 - 20;
        const amp = 10 + rand() * 8;
        const phase = rand() * Math.PI * 2;
        const freq = 5 + Math.floor(rand() * 3);
        let d = `M-10 1044`;
        for (let x = -10; x <= 1034; x += 8) {
          const y = base + amp * Math.sin((x / 1024) * Math.PI * 2 * freq + phase);
          d += `L${x} ${r1(y)}`;
        }
        d += "L1034 1044Z";
        const t = rI / (rows - 1);
        const col = rI % 2 === 0 ? mixHex("#38bdf8", "#0e7490", t) : mixHex("#0ea5e9", "#155e75", t);
        body += `<path d="${d}" fill="${col}" stroke="#e0f7ff" stroke-opacity="0.55" stroke-width="3"/>`;
      }
      return skinSvg("", body);
    },
  },
  {
    name: "circuit_board",
    rarity: "epic",
    svg() {
      const rand = prng(606);
      const step = 32;
      const n = SKIN_SIZE / step;
      let body = `<rect width="1024" height="1024" fill="#0b2e22"/>`;
      body += `<path d="${Array.from({ length: n + 1 }, (_, i) => `M${i * step} 0V1024M0 ${i * step}H1024`).join("")}" stroke="#134e3a" stroke-width="1"/>`;
      let traces = "";
      let pads = "";
      const dirs = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ];
      for (let t = 0; t < 70; t++) {
        let x = Math.floor(rand() * n);
        let y = Math.floor(rand() * n);
        let d = `M${x * step} ${y * step}`;
        let dir = Math.floor(rand() * 4);
        pads += `<circle cx="${x * step}" cy="${y * step}" r="6" fill="#0b2e22" stroke="#facc15" stroke-width="3"/>`;
        const len = 4 + Math.floor(rand() * 10);
        for (let s = 0; s < len; s++) {
          if (rand() < 0.3) dir = (dir + (rand() < 0.5 ? 1 : 3)) % 4;
          x = Math.max(0, Math.min(n, x + dirs[dir][0]));
          y = Math.max(0, Math.min(n, y + dirs[dir][1]));
          d += `L${x * step} ${y * step}`;
        }
        traces += `<path d="${d}"/>`;
        pads += `<circle cx="${x * step}" cy="${y * step}" r="5" fill="#facc15"/>`;
      }
      body += `<g fill="none" stroke="#34d399" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">${traces}</g>${pads}`;
      for (let c = 0; c < 10; c++) {
        const x = Math.floor(rand() * (n - 3)) * step + 8;
        const y = Math.floor(rand() * (n - 3)) * step + 8;
        body += `<rect x="${x}" y="${y}" width="${step * 2 - 16}" height="${step * 1.5}" rx="4" fill="#111827" stroke="#9ca3af" stroke-width="2"/>`;
      }
      return skinSvg("", body);
    },
  },
  {
    name: "mosaic",
    rarity: "rare",
    svg() {
      const rand = prng(707);
      const jewels = ["#b91c1c", "#1d4ed8", "#047857", "#a16207", "#7e22ce", "#0e7490", "#c2410c"];
      const R = 34;
      const w = Math.sqrt(3) * R;
      const h = 1.5 * R;
      let body = `<rect width="1024" height="1024" fill="#1c1917"/>`;
      for (let row = -1; row * h < SKIN_SIZE + R; row++) {
        for (let col = -1; col * w < SKIN_SIZE + w; col++) {
          const cx = col * w + (row % 2 === 0 ? 0 : w / 2);
          const cy = row * h;
          const dist = Math.hypot(cx - C, cy - C);
          const base = jewels[Math.floor((dist / 90 + rand() * 1.2) % jewels.length)];
          const col2 = shadeHex(base, (rand() - 0.4) * 0.45);
          let d = "";
          for (let k = 0; k < 6; k++) {
            const a = Math.PI / 6 + (k * Math.PI) / 3;
            d += `${k === 0 ? "M" : "L"}${r1(cx + (R - 3) * Math.cos(a))} ${r1(cy + (R - 3) * Math.sin(a))}`;
          }
          body += `<path d="${d}Z" fill="${col2}"/>`;
        }
      }
      body += `<rect width="1024" height="1024" fill="url(#shine)"/>`;
      return skinSvg(
        `<radialGradient id="shine" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff" stop-opacity="0.25"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`,
        body,
      );
    },
  },
];

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
          const rot = side * ((a * 180) / Math.PI) + (side < 0 ? 180 : 0) + 90 * side;
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

const RAINBOW = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be", "#007aff", "#af52de"];

const EFFECT_DEFS = {
  transportShipTrail: [
    ["sea_foam", "common", { type: "gradient", colors: ["#e0f7ff", "#7fd6ff", "#2a8cff"], colorSize: 4, movementSpeed: 8 }],
    ["sunset_wake", "uncommon", { type: "gradient", colors: ["#ff5e62", "#ff9966", "#ffd86f"], colorSize: 5, movementSpeed: 10 }],
    ["neon_pulse", "rare", { type: "transition", colors: ["#ff2bd6", "#00e5ff", "#a6ff00"], frequency: 1.5 }],
    ["prism_wake", "epic", { type: "gradient", colors: RAINBOW, colorSize: 3, movementSpeed: 14 }],
  ],
  nukeTrail: [
    ["toxic_glow", "uncommon", { type: "gradient", colors: ["#d9f99d", "#84cc16", "#365314"], colorSize: 4, movementSpeed: 12 }],
    ["warning_lights", "rare", { type: "transition", colors: ["#ef4444", "#facc15"], frequency: 3 }],
    ["double_helix", "epic", { type: "spiral", colors: ["#38bdf8", "#f472b6"], radius: 6, strands: 2, rotationSpeed: 5 }],
    ["vortex", "legendary", { type: "spiral", colors: ["#a855f7", "#22d3ee", "#ffffff"], radius: 8, strands: 4, rotationSpeed: 7 }],
  ],
  nukeExplosion: [
    ["solar_flare", "rare", { type: "shockwave", nukeType: "atom", colors: ["#fff7d6", "#fbbf24", "#f97316", "#b91c1c"], size: 200, speed: 140, thickness: 5, transitionSpeed: 2 }],
    ["starburst", "epic", { type: "sparkles", nukeType: "atom", colors: ["#ffffff", "#fde68a", "#93c5fd"], size: 190, speed: 120, thickness: 3, transitionSpeed: 3, density: 300 }],
    ["cinder_bloom", "uncommon", { type: "embers", nukeType: "atom", colors: ["#fef3c7", "#fb923c", "#dc2626", "#451a03"], size: 180, speed: 110, thickness: 3, transitionSpeed: 1.5, density: 260 }],
    ["tidal_ring", "rare", { type: "shockwave", nukeType: "hydro", colors: ["#ecfeff", "#67e8f9", "#0891b2", "#1e3a8a"], size: 420, speed: 220, thickness: 8, transitionSpeed: 1.5 }],
    ["glitter_storm", "legendary", { type: "sparkles", nukeType: "hydro", colors: ["#f0abfc", "#a78bfa", "#67e8f9", "#ffffff"], size: 400, speed: 200, thickness: 4, transitionSpeed: 4, density: 450 }],
    ["magma_rain", "epic", { type: "embers", nukeType: "hydro", colors: ["#fde047", "#f97316", "#b91c1c", "#292524"], size: 380, speed: 180, thickness: 4, transitionSpeed: 2, density: 400 }],
    ["split_halo", "uncommon", { type: "shockwave", nukeType: "mirvWarhead", colors: ["#ffffff", "#a5b4fc", "#6366f1"], size: 70, speed: 90, thickness: 3, transitionSpeed: 3 }],
    ["confetti_pop", "rare", { type: "sparkles", nukeType: "mirvWarhead", colors: ["#f43f5e", "#facc15", "#22c55e", "#3b82f6"], size: 70, speed: 80, thickness: 2.5, transitionSpeed: 5, density: 120 }],
    ["spark_shower", "common", { type: "embers", nukeType: "mirvWarhead", colors: ["#fff7ed", "#fdba74", "#ea580c"], size: 60, speed: 70, thickness: 2, transitionSpeed: 2, density: 110 }],
  ],
  structures: [
    ["gilded", "rare", { type: "gradient", colors: ["#fff1a8", "#f5b700", "#a86b00"], colorSize: 4, movementSpeed: 6 }],
    ["chameleon", "epic", { type: "transition", colors: ["#22c55e", "#06b6d4", "#a855f7", "#f43f5e"], frequency: 0.8 }],
    ["frostbite", "uncommon", { type: "gradient", colors: ["#f0f9ff", "#7dd3fc", "#0284c7"], colorSize: 3, movementSpeed: 4 }],
  ],
  warship: [
    ["steel_tide", "uncommon", { type: "gradient", colors: ["#e2e8f0", "#64748b", "#1e293b"], colorSize: 4, movementSpeed: 8 }],
    ["phantom", "epic", { type: "transition", colors: ["#a78bfa", "#1e1b4b"], frequency: 1 }],
    ["crimson_fleet", "rare", { type: "gradient", colors: ["#fecaca", "#dc2626", "#450a0a"], colorSize: 3, movementSpeed: 10 }],
  ],
  train: [
    ["golden_express", "rare", { type: "gradient", colors: ["#fde68a", "#d97706", "#78350f"], colorSize: 4, movementSpeed: 10 }],
    ["neon_line", "epic", { type: "transition", colors: ["#f0abfc", "#22d3ee", "#a3e635"], frequency: 2 }],
    ["midnight_run", "uncommon", { type: "gradient", colors: ["#312e81", "#6366f1", "#c7d2fe"], colorSize: 5, movementSpeed: 8 }],
  ],
  railroad: [
    ["copper_rails", "uncommon", { type: "gradient", colors: ["#fdba74", "#c2410c", "#7c2d12"], colorSize: 6, movementSpeed: 0 }],
    ["glow_track", "rare", { type: "gradient", colors: ["#34d399", "#22d3ee", "#818cf8"], colorSize: 5, movementSpeed: 6 }],
    ["candy_stripe", "epic", { type: "gradient", colors: ["#ffffff", "#ef4444"], colorSize: 2, movementSpeed: 3 }],
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
  for (const d of defs) fs.writeFileSync(path.join(dir, `${d.name}.svg`), d.svg());
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
