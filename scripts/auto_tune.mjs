// AUTO-TUNE — render a batch with NO per-SKU rules.
//
//   node --env-file=.env scripts/auto_tune.mjs --group group_sofa --bg F7F7F7 \
//     --out outputs/finals_auto --sheet outputs/contact_sheet_auto.jpg [--hd --no-plate]
//
// Every knob that was being set by hand (strength, exposure, shade) is solved per SKU from
// measurements of that SKU's own pixels, against THREE global targets. `highlights:auto` already
// derives the lift the same way, so after this nothing is hand-set.
//
//   contrast   p25-p95 spread of the product == TARGET_SPREAD      -> solves `strength`
//   clearance  product body p90 <= bg - BACKDROP_GAP               -> solves `exposure`
//   shadows    product p01 >= TARGET_FLOOR                         -> solves `shade`
//
// The targets are calibrated from the six F7F7F7 sofas that were signed off by hand: those landed
// at spread 66-73, body p90 at or under bg-10, and p01 >= 83. They are the ONLY taste input; they
// are set once for the batch instead of per SKU.
//
// Method: strength and shade are both near-linear in their measured statistic (verified: strength
// 0.25/0.40/0.55/0.75 gave spread 53/60/67/75 on one SKU and 62/68/73 on another, ~38 per unit), so
// two probes and a secant step land within a couple of levels. Exposure needs no search — it scales
// the product linearly, so it is solved in closed form from the source.
//
// This shells out to run_pipeline.mjs rather than reimplementing the composite: same code path as a
// normal run, and every probe is composite-only (matte/shadow/relit come from cache), so a solve
// costs no API calls once a SKU's stages exist.

import { execFile } from "node:child_process";
import { readdir, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const GROUP = arg("--group", "group_sofa");
const BG = arg("--bg", "F7F7F7").toUpperCase();
const OUT = arg("--out", "outputs/finals_auto");
const SHEET = arg("--sheet", "outputs/contact_sheet_auto.jpg");
const HD = process.argv.includes("--hd"), NP = process.argv.includes("--no-plate");
const DRY = process.argv.includes("--dry-run");           // solve + report, do not write the set

// ---- the three targets (the only taste input) -------------------------------------------------
const TARGET_SPREAD = 70;      // p25-p95 of the product
const BACKDROP_GAP = 10;       // body p90 must sit this far under the backdrop
const TARGET_FLOOR = 83;       // product p01 must not fall below this
// ---- search bounds ----------------------------------------------------------------------------
const S_MIN = 0.20, S_MAX = 0.80, E_MIN = 0.90, SH_MIN = 0.45;
const N = 1000;                // analysis resolution

const bgLuma = (() => {
  const r = parseInt(BG.slice(0, 2), 16), g = parseInt(BG.slice(2, 4), 16), b = parseInt(BG.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
})();
const SUF = `${NP ? "_np" : ""}${HD ? "_hd" : ""}`;
const q = (v, f) => v[Math.floor(f * (v.length - 1))];

async function alphaOf(sku) {
  return sharp(join("outputs/work", sku, `matte${SUF}.png`))
    .ensureAlpha().extractChannel(3).resize(N, N).raw().toBuffer();
}
// luma percentiles over the product pixels of an image
async function stats(path, alpha) {
  const { data } = await sharp(path).resize(N, N).raw().toBuffer({ resolveWithObject: true });
  const v = [];
  for (let p = 0; p < alpha.length; p++) {
    if (alpha[p] < 200) continue;
    const i = p * 3;
    v.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  v.sort((a, b) => a - b);
  return { spread: q(v, 0.95) - q(v, 0.25), p01: q(v, 0.01), p90: q(v, 0.90) };
}
// source-side body p90, on the matte flattened onto the target bg — drives exposure
async function sourceP90(sku, alpha) {
  const { data } = await sharp(join("outputs/work", sku, `matte${SUF}.png`))
    .flatten({ background: `#${BG}` }).resize(N, N).raw().toBuffer({ resolveWithObject: true });
  const v = [];
  for (let p = 0; p < alpha.length; p++) {
    if (alpha[p] < 200) continue;
    const i = p * 3;
    v.push(Math.max(data[i], data[i + 1], data[i + 2]));
  }
  v.sort((a, b) => a - b);
  return q(v, 0.90);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => Math.round(v * 100) / 100;

// one composite at the given settings; returns the rendered path
async function render(sku, { strength, exposure, shade }, out) {
  const a = ["--env-file=.env", "scripts/run_pipeline.mjs", "--group", GROUP, "--skus", sku,
    "--highlights", "auto", "--bg", BG, "--strength", String(strength),
    "--exposure", String(exposure), "--shade", String(shade), "--out", out, "--sheet", join(out, "_s.jpg")];
  if (HD) a.push("--hd");
  if (NP) a.push("--no-plate");
  await run("node", a, { maxBuffer: 1 << 26 });
  return join(out, GROUP, `${sku}.jpg`);
}

const files = (await readdir(join("inputs", GROUP))).filter((f) => /\.jpe?g$/i.test(f)).sort();
const skus = files.map((f) => f.replace(/\.jpe?g$/i, ""));
const TMP = "outputs/work/_autotune";
await mkdir(join(OUT, GROUP), { recursive: true });

console.log(`auto-tune ${skus.length} SKUs · targets: spread ${TARGET_SPREAD}, body p90 <= ${Math.round(bgLuma - BACKDROP_GAP)}, p01 >= ${TARGET_FLOOR}\n`);
const report = [];
for (const sku of skus) {
  const alpha = await alphaOf(sku).catch(() => null);
  let exposure = 1;
  if (alpha) {
    // closed form: exposure scales the product linearly, so aim its body p90 at the clearance line
    exposure = clamp(Math.min(1, (bgLuma - BACKDROP_GAP) / await sourceP90(sku, alpha)), E_MIN, 1);
    exposure = r2(exposure);
  }
  // two strength probes -> secant. First probe also creates the stages if this SKU has none yet.
  const probes = [];
  for (const s of [0.30, 0.60]) {
    const p = await render(sku, { strength: s, exposure, shade: 1 }, TMP);
    const al = alpha ?? await alphaOf(sku);
    probes.push({ s, ...(await stats(p, al)) });
  }
  const al = alpha ?? await alphaOf(sku);
  const slope = (probes[1].spread - probes[0].spread) / (probes[1].s - probes[0].s);
  let strength = clamp(probes[0].s + (TARGET_SPREAD - probes[0].spread) / (slope || 1), S_MIN, S_MAX);
  strength = r2(strength);

  // shade: measure the shadow floor at the chosen strength, open it up if it crushed
  let shade = 1;
  let path = await render(sku, { strength, exposure, shade }, TMP);
  let st = await stats(path, al);
  if (st.p01 < TARGET_FLOOR) {
    const probe = await render(sku, { strength, exposure, shade: 0.6 }, TMP);
    const sp = await stats(probe, al);
    const sl = (sp.p01 - st.p01) / (0.6 - 1);
    shade = r2(clamp(1 + (TARGET_FLOOR - st.p01) / (sl || 1), SH_MIN, 1));
    path = await render(sku, { strength, exposure, shade }, TMP);
    st = await stats(path, al);
  }
  if (!DRY) await copyFile(path, join(OUT, GROUP, `${sku}.jpg`));
  report.push({ sku, strength, exposure, shade, ...st });
  console.log(`${sku.padEnd(11)} strength ${String(strength).padEnd(5)} exposure ${String(exposure).padEnd(5)} shade ${String(shade).padEnd(5)} -> spread ${Math.round(st.spread)}  p01 ${Math.round(st.p01)}  p90 ${Math.round(st.p90)}`);
}

const sd = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length); };
console.log(`\nconsistency across the batch: spread ${Math.round(report.reduce((a, r) => a + r.spread, 0) / report.length)} ± ${sd(report.map((r) => r.spread)).toFixed(1)}`);
console.log(`hand-set values used: none. ${report.filter((r) => r.shade < 1).length}/${report.length} needed the shadow floor opened.`);
if (!DRY) console.log(`\n${report.length} finals -> ${join(OUT, GROUP)}`);
