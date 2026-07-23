#!/usr/bin/env node
/**
 * Performance-budget gate (spec §5 performance budgets, NFR). The clinic runs on
 * modest hardware over intermittent links, so the shipped bundle is a release
 * constraint, not a nicety. This gate gzips the built PWA assets and enforces:
 *
 *   - JS   ≤ 250 KB gz (baseline)  · hard cap 350 KB gz  → FAIL over the cap
 *   - CSS  ≤  50 KB gz (hard cap)                          → FAIL over the cap
 *
 * Between the JS baseline and the hard cap it warns (visible, non-blocking) so
 * regressions surface early without flapping the build on a few kB. Sizes are
 * measured gzipped because that is what the client actually downloads.
 *
 * Run after `npm run build -w @sancta/clinic-web`. Reads the built dist/ directly,
 * so it measures exactly what deploys.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1024;
const JS_BASELINE = 250 * KB;
const JS_HARD_CAP = 350 * KB;
const CSS_HARD_CAP = 50 * KB;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distAssets = join(repoRoot, 'apps', 'clinic-web', 'dist', 'assets');

if (!existsSync(distAssets)) {
  console.error(`✖ perf-budget: ${distAssets} not found — run \`npm run build -w @sancta/clinic-web\` first.`);
  process.exit(1);
}

/** Total gzipped bytes of every dist asset with the given extension. */
function gzTotal(ext) {
  return readdirSync(distAssets)
    .filter((f) => f.endsWith(ext))
    .reduce((sum, f) => sum + gzipSync(readFileSync(join(distAssets, f))).length, 0);
}

const jsGz = gzTotal('.js');
const cssGz = gzTotal('.css');
const kb = (n) => `${(n / KB).toFixed(1)} KB`;

let failed = false;
const notes = [];

if (jsGz > JS_HARD_CAP) {
  failed = true;
  notes.push(`✖ JS ${kb(jsGz)} gz exceeds the HARD CAP of ${kb(JS_HARD_CAP)} — trim or split before shipping.`);
} else if (jsGz > JS_BASELINE) {
  notes.push(`⚠ JS ${kb(jsGz)} gz is over the ${kb(JS_BASELINE)} baseline (cap ${kb(JS_HARD_CAP)}) — watch for regressions.`);
} else {
  notes.push(`✓ JS ${kb(jsGz)} gz (baseline ${kb(JS_BASELINE)}, cap ${kb(JS_HARD_CAP)}).`);
}

if (cssGz > CSS_HARD_CAP) {
  failed = true;
  notes.push(`✖ CSS ${kb(cssGz)} gz exceeds the ${kb(CSS_HARD_CAP)} cap.`);
} else {
  notes.push(`✓ CSS ${kb(cssGz)} gz (cap ${kb(CSS_HARD_CAP)}).`);
}

console.log(notes.join('\n'));
if (failed) {
  console.error('✖ perf-budget: bundle exceeds the release budget.');
  process.exit(1);
}
console.log('✓ perf-budget: within the release budget.');
