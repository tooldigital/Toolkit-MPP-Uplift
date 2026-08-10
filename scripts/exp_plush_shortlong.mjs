// EXPERIMENT BATCH — no-plate + HD, F7F7F7 finals, SHORT vs LONG shadow, all four plushes.
//
// Combines the two threads:
//   - no plate: raw input → Photoroom v2/edit with referenceBox=originalImage (framing, no makePlate)
//   - HD:       pr-hd-background-removal header on the matte (crisper fur-strand edges)
//   - shadow:   two presets side by side — LONG (directional behindRight; the current pipeline default,
//               which leaves a bright rim on dark contours) and SHORT (soft grounding; hugs the contact).
// Opaque composite on F7F7F7 (matte over bg, bg darkened by the shadow factor). NO relight — kept
// deterministic / self-contained (no Gemini); the shipped _normal finals add a barely-visible 0.08.
//
// Not wired into the pipeline. Writes only to outputs/experiments/plush_shortlong_noplate_hd/.
// Reuses cached intermediates from the earlier experiments to avoid re-fetching:
//   HD matte  ← referencebox/<sku>_matte_hd.png
//   LONG shad ← referencebox/<sku>_shadow.jpg          (white bg, referenceBox, long preset)
//   SHORT shad← shadowfix/<sku>_shadow_short.jpg        (panda only; others fetched here)
// Anything missing is generated via one Photoroom call and cached in the output folder.
//
//   node --env-file=.env scripts/exp_plush_shortlong.mjs [SKU ...] [--bg F7F7F7]

import { mkdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const ENDPOINT = "https://image-api.photoroom.com/v2/edit";
const SHADOW_MODEL_VERSION = "2026-04-15";
const W = 4000;

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BG = arg("--bg", "F7F7F7").toUpperCase();
const SKUS = argv.filter((a) => /^PE\d+$/.test(a));
if (!SKUS.length) SKUS.push("PE317642", "PE371748", "PE936323", "PE964848");

const prKey = process.env.PHOTOROOM_KEY;
if (!prKey) { console.error("Set PHOTOROOM_KEY in .env"); process.exit(1); }

const IN = "inputs/group_plush";
const OUT = "outputs/experiments/plush_shortlong_noplate_hd";
const SEED_RB = "outputs/experiments/referencebox";       // HD matte + long shadow
const SEED_SF = "outputs/experiments/shadowfix";           // panda short shadow
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => stat(p).then(() => true, () => false);

const SHADOW = {
  long:  { softness: "0.6",  intensity: "0.55", spread: "long",  direction: "behindRight" },
  short: { softness: "0.75", intensity: "0.5",  spread: "short" },   // grounding, no direction
};

// One v2/edit call on the RAW input, referenceBox=originalImage. kind = "matte" | preset name.
async function edit(kind, srcPath) {
  const buf = await readFile(srcPath);
  const fd = new FormData();
  fd.append("imageFile", new Blob([buf]), srcPath.split("/").pop());
  fd.append("referenceBox", "originalImage");
  fd.append("outputSize", `${W}x${W}`);
  fd.append("padding", "0.10");
  fd.append("removeBackground", "true");
  const headers = { "x-api-key": prKey };
  if (kind === "matte") {
    fd.append("export.format", "png");
    headers["pr-hd-background-removal"] = "auto";           // HD matte
  } else {
    const s = SHADOW[kind];
    fd.append("shadow.mode", "ai.auto-with-overrides");
    fd.append("shadow.softnessOverride", s.softness);
    fd.append("shadow.intensityOverride", s.intensity);
    fd.append("shadow.spreadOverride", s.spread);
    if (s.direction) fd.append("shadow.directionOverride", s.direction);
    fd.append("shadow.subjectPoseOverride", "upright");
    fd.append("background.color", "FFFFFF");                 // shadow base ALWAYS white (see referencebox notes)
    fd.append("export.format", "jpeg");
    headers["pr-ai-shadows-model-version"] = SHADOW_MODEL_VERSION;
  }
  const res = await fetch(ENDPOINT, { method: "POST", headers, body: fd });
  if (!res.ok) throw new Error(`Photoroom ${kind} ${res.status}: ${(await res.text().catch(() => "")) || res.statusText}`);
  return Buffer.from(new Uint8Array(await res.arrayBuffer()));
}

// Return cached bytes, seeding from a prior experiment folder if present, else fetch+cache.
async function ensure(path, seed, fetchFn) {
  if (await exists(path)) return readFile(path);
  if (seed && await exists(seed)) { await copyFile(seed, path); return readFile(path); }
  const bytes = await fetchFn(); await writeFile(path, bytes); await sleep(1200); return bytes;
}

function composite(subj, A, base, bgR, bgG, bgB) {
  const out = Buffer.alloc(W * W * 3);
  for (let p = 0, i = 0; p < W * W; p++, i += 3) {
    const a = A[p] / 255, L = gray(base[i], base[i + 1], base[i + 2]);
    const sf = (a * 255 + (1 - a) * L) / 255;
    out[i]     = clamp(subj[i]     * a + bgR * sf * (1 - a));
    out[i + 1] = clamp(subj[i + 1] * a + bgG * sf * (1 - a));
    out[i + 2] = clamp(subj[i + 2] * a + bgB * sf * (1 - a));
  }
  return out;
}

await mkdir(OUT, { recursive: true });
const bgR = parseInt(BG.slice(0, 2), 16), bgG = parseInt(BG.slice(2, 4), 16), bgB = parseInt(BG.slice(4, 6), 16);
const results = [];

for (const sku of SKUS) {
  process.stdout.write(`${sku} `);
  try {
    const src = join(IN, `${sku}.jpg`);
    const matteBytes = await ensure(join(OUT, `${sku}_matte_hd.png`), join(SEED_RB, `${sku}_matte_hd.png`), () => (process.stdout.write("[HD matte] "), edit("matte", src)));
    const longBytes  = await ensure(join(OUT, `${sku}_shadow_long.jpg`),  join(SEED_RB, `${sku}_shadow.jpg`),       () => (process.stdout.write("[long] "),  edit("long",  src)));
    const shortBytes = await ensure(join(OUT, `${sku}_shadow_short.jpg`), join(SEED_SF, `${sku}_shadow_short.jpg`), () => (process.stdout.write("[short] "), edit("short", src)));

    const subj = await sharp(matteBytes).resize(W, W).removeAlpha().raw().toBuffer();
    const A    = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const jpeg = (buf) => sharp(buf, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();

    const outs = {};
    for (const [name, shadow] of [["long", longBytes], ["short", shortBytes]]) {
      const base = await sharp(shadow).resize(W, W).removeAlpha().raw().toBuffer();
      const buf = await jpeg(composite(subj, A, base, bgR, bgG, bgB));
      await writeFile(join(OUT, `${sku}_${name}.jpg`), buf);
      outs[name] = buf;
    }

    // per-SKU long-vs-short compare
    const C = 1000, Lh = 32;
    const label = (t) => Buffer.from(`<svg width="${C}" height="${Lh}"><rect width="100%" height="100%" fill="black"/><text x="8" y="22" font-family="monospace" font-size="19" fill="white">${t}</text></svg>`);
    const cell = async (b, t) => sharp({ create: { width: C, height: C + Lh, channels: 3, background: "#fff" } })
      .composite([{ input: await sharp(b).resize(C, C, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).toBuffer(), top: Lh, left: 0 }, { input: label(t), top: 0, left: 0 }]).png().toBuffer();
    await sharp({ create: { width: C * 2, height: C + Lh, channels: 3, background: "#222" } })
      .composite([{ input: await cell(outs.long, `${sku}  LONG`), left: 0, top: 0 }, { input: await cell(outs.short, `${sku}  SHORT`), left: C, top: 0 }])
      .jpeg({ quality: 92 }).toFile(join(OUT, `${sku}_compare.jpg`));
    results.push({ sku, long: outs.long, short: outs.short });
    console.log("ok");
  } catch (e) {
    console.log("FAIL: " + e.message);
    if (String(e.message).includes("429")) { console.error("Rate-limited — re-run to resume."); break; }
  }
}

// batch sheet: 2 columns (LONG | SHORT), one row per SKU
if (results.length) {
  const C = 700, Lh = 28, HEAD = 30;
  const label = (t, w) => Buffer.from(`<svg width="${w}" height="${Lh}"><rect width="100%" height="100%" fill="black"/><text x="8" y="20" font-family="monospace" font-size="17" fill="white">${t}</text></svg>`);
  const head = Buffer.from(`<svg width="${C * 2}" height="${HEAD}"><rect width="100%" height="100%" fill="#111"/><text x="8" y="21" font-family="monospace" font-size="18" fill="#8f8">LONG (current)</text><text x="${C + 8}" y="21" font-family="monospace" font-size="18" fill="#8f8">SHORT (grounding)</text></svg>`);
  const cell = async (b, t) => sharp({ create: { width: C, height: C + Lh, channels: 3, background: "#fff" } })
    .composite([{ input: await sharp(b).resize(C, C, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).toBuffer(), top: Lh, left: 0 }, { input: label(t, C), top: 0, left: 0 }]).png().toBuffer();
  const rows = [];
  for (const r of results) rows.push(await sharp({ create: { width: C * 2, height: C + Lh, channels: 3, background: "#222" } })
    .composite([{ input: await cell(r.long, `${r.sku} long`), left: 0, top: 0 }, { input: await cell(r.short, `${r.sku} short`), left: C, top: 0 }]).png().toBuffer());
  const H = C + Lh;
  await sharp({ create: { width: C * 2, height: HEAD + H * rows.length, channels: 3, background: "#222" } })
    .composite([{ input: head, left: 0, top: 0 }, ...rows.map((rr, i) => ({ input: rr, left: 0, top: HEAD + i * H }))])
    .jpeg({ quality: 90 }).toFile(join(OUT, `_batch_sheet.jpg`));
  console.log(`batch sheet → ${OUT}/_batch_sheet.jpg`);
}
console.log(`\nDone → ${OUT}/  (<sku>_long.jpg, <sku>_short.jpg, <sku>_compare.jpg, _batch_sheet.jpg)`);
