#!/usr/bin/env node
// Regenerates the flags of the bundled, free cosmetics catalog
// (resources/cosmetics/cosmetics.json) from the SVGs in resources/flags that
// are not plain country flags (resources/countries.json) -- those are already
// selectable as "country:<code>" flags.
//
// Everything else in the catalog (patterns, skins, crowns, effects, colour
// palettes) is kept as it is, so a catalog exported from elsewhere can be
// dropped into the file and survives a regeneration.
//
//   node scripts/generate-cosmetics-catalog.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "resources/cosmetics/cosmetics.json");
const countries = JSON.parse(
  fs.readFileSync(path.join(root, "resources/countries.json"), "utf8"),
);
const countryCodes = new Set(countries.map((c) => c.code));

function slug(name) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

const existing = fs.existsSync(catalogPath)
  ? JSON.parse(fs.readFileSync(catalogPath, "utf8"))
  : { patterns: {}, flags: {} };

const flags = {};
const taken = new Set();
const files = fs
  .readdirSync(path.join(root, "resources/flags"))
  .filter((f) => f.endsWith(".svg"))
  .map((f) => f.slice(0, -".svg".length))
  .filter((code) => !countryCodes.has(code))
  .sort();
for (const code of files) {
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

const catalog = { ...existing, patterns: existing.patterns ?? {}, flags };
fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
console.log(`Wrote ${Object.keys(flags).length} flags to ${catalogPath}`);
