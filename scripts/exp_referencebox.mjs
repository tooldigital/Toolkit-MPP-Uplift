// EXPERIMENT — no-plate framing via Photoroom `referenceBox=originalImage`.
//
// Question: can we drop the manual makePlate() step (which detects the subject by luminance,
// scales it to a 3200/4000 box for the 400px margin, and re-composites on white) and instead
// send the RAW IKEA input straight to Photoroom, letting `referenceBox=originalImage` + padding
// do the framing?  Default `referenceBox=subjectBox` reframes the subject to fill the target
// (killing our margin); `originalImage` fits the WHOLE input into the target minus padding, so
// the subject keeps its original relative position/scale.
//
// This does NOT touch the pipeline. It writes only to outputs/experiments/referencebox/.
//
//   node --env-file=.env scripts/exp_referencebox.mjs [SKU ...] [--bg F7F7F7] [--padding 0.10]
//
// Per SKU it makes two Photoroom v2/edit calls on the raw input (referenceBox=originalImage):
//   removeBackground  → matte (crisp pixels + alpha)     → outputs .../<sku>_matte.png
//   generateShadow    → product + cast shadow on <bg>    → outputs .../<sku>_shadow.jpg
// then the same opaque composite the pipeline uses (matte over bg, bg darkened by the shadow),
// NO relight (deterministic, no Gemini) → <sku>_noplate.jpg, and a 2-up compare vs the current
// plate-based _normal.jpg final → <sku>_compare.jpg.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const ENDPOINT = "https://image-api.photoroom.com/v2/edit";
const SHADOW_MODEL_VERSION = "2026-04-15";
const W = 4000;

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BG = arg("--bg", "F7F7F7").toUpperCase();
const PADDING = arg("--padding", "0.10");
// --hd: HD background removal on the matte (pr-hd-background-removal header) — crisper fur-strand
// edges. Only the matte gets HD (the shadow render is soft); files get an _hd suffix and the
// compare pits it against the plate-based _normalhd.jpg baseline instead of _normal.jpg.
const HD = argv.includes("--hd");
const SUF = HD ? "_hd" : "";
const SKUS = argv.filter((a) => /^PE\d+$/.test(a));
if (!SKUS.length) SKUS.push("PE317642", "PE371748", "PE936323", "PE964848");

const prKey = process.env.PHOTOROOM_KEY;
if (!prKey) { console.error("Set PHOTOROOM_KEY in .env"); process.exit(1); }

const OUT = "outputs/experiments/referencebox";
const IN = "inputs/group_plush";
const NORMAL = "outputs/finals_plush_f7f7f7_all/group_plush";
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One v2/edit call on the RAW input, referenceBox=originalImage. `mode` = "matte" | "shadow".
async function edit(mode, srcPath, bg) {
  const buf = await readFile(srcPath);
  const fd = new FormData();
  fd.append("imageFile", new Blob([buf]), srcPath.split("/").pop());
  fd.append("referenceBox", "originalImage");       // <-- the whole point of the experiment
  fd.append("outputSize", `${W}x${W}`);
  fd.append("padding", String(PADDING));
  if (mode === "matte") {
    fd.append("removeBackground", "true");
    fd.append("export.format", "png");
  } else {
    fd.append("removeBackground", "true");          // shadow render also removes the original bg
    fd.append("shadow.mode", "ai.auto-with-overrides");
    fd.append("shadow.softnessOverride", "0.6");
    fd.append("shadow.intensityOverride", "0.55");
    fd.append("shadow.spreadOverride", "long");
    fd.append("shadow.directionOverride", "behindRight");
    fd.append("shadow.subjectPoseOverride", "upright");
    // Shadow base ALWAYS on WHITE, like the pipeline's opaque path — the composite derives a
    // shadow FACTOR (luminance/255) from it and darkens the chosen bg by that. Rendering on the
    // target bg instead would double-darken it (sf<1 in clear areas → whole bg dragged down).
    fd.append("background.color", "FFFFFF");
    fd.append("export.format", "jpeg");
  }
  const headers = { "x-api-key": prKey };
  if (mode === "shadow") headers["pr-ai-shadows-model-version"] = SHADOW_MODEL_VERSION;
  if (mode === "matte" && HD) headers["pr-hd-background-removal"] = "auto";
  const res = await fetch(ENDPOINT, { method: "POST", headers, body: fd });
  if (!res.ok) throw new Error(`Photoroom ${mode} ${res.status}: ${(await res.text().catch(() => "")) || res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

await mkdir(OUT, { recursive: true });
const bgR = parseInt(BG.slice(0, 2), 16), bgG = parseInt(BG.slice(2, 4), 16), bgB = parseInt(BG.slice(4, 6), 16);

for (const sku of SKUS) {
  process.stdout.write(`${sku} ... `);
  try {
    const src = join(IN, `${sku}.jpg`);

    // 1. matte (crisp pixels + alpha) — HD when --hd. 2. shadow render (soft; HD n/a). Both on the
    //    raw input, referenceBox=originalImage. The shadow is HD-independent, so reuse a cached
    //    <sku>_shadow.jpg from a prior run to avoid a redundant API call.
    const matteBytes = await edit("matte", src, BG);
    await writeFile(join(OUT, `${sku}_matte${SUF}.png`), Buffer.from(matteBytes));
    await sleep(1200);
    const shadowPath = join(OUT, `${sku}_shadow.jpg`);
    let shadowBytes;
    try { shadowBytes = await readFile(shadowPath); }
    catch { shadowBytes = Buffer.from(await edit("shadow", src, BG)); await writeFile(shadowPath, shadowBytes); await sleep(1200); }

    // 3. Same opaque composite as the pipeline (no relight): matte over bg, bg darkened by the
    //    shadow render. subj = crisp original pixels (straight), a = alpha, base = shadow-on-bg.
    const subj = await sharp(Buffer.from(matteBytes)).resize(W, W).removeAlpha().raw().toBuffer();
    const sAlpha = await sharp(Buffer.from(matteBytes)).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const base = await sharp(Buffer.from(shadowBytes)).resize(W, W).removeAlpha().raw().toBuffer();
    const out = Buffer.alloc(W * W * 3);
    for (let p = 0, i = 0; p < W * W; p++, i += 3) {
      const a = sAlpha[p] / 255;
      // cast-shadow darkening of the chosen bg; product region excluded (no edge halo)
      const sf = (a * 255 + (1 - a) * gray(base[i], base[i + 1], base[i + 2])) / 255;
      out[i]     = clamp(subj[i]     * a + bgR * sf * (1 - a));
      out[i + 1] = clamp(subj[i + 1] * a + bgG * sf * (1 - a));
      out[i + 2] = clamp(subj[i + 2] * a + bgB * sf * (1 - a));
    }
    const noplate = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    await writeFile(join(OUT, `${sku}_noplate${SUF}.jpg`), noplate);

    // 4. 2-up compare vs the matching plate-based baseline (_normalhd.jpg under --hd, else _normal.jpg).
    const C = 1000, L = 30;
    const label = (t) => Buffer.from(`<svg width="${C}" height="${L}"><rect width="100%" height="100%" fill="black"/><text x="8" y="21" font-family="monospace" font-size="18" fill="white">${t}</text></svg>`);
    const cell = async (bytes, t) => sharp({ create: { width: C, height: C + L, channels: 3, background: "#fff" } })
      .composite([{ input: await sharp(bytes).resize(C, C, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).toBuffer(), top: L, left: 0 }, { input: label(t), top: 0, left: 0 }])
      .png().toBuffer();
    const normalPath = join(NORMAL, `${sku}_normal${HD ? "hd" : ""}.jpg`);
    const tag = HD ? "HD" : "";
    const left = await cell(await readFile(normalPath), `${sku}  PLATE (normal${tag})`);
    const right = await cell(noplate, `${sku}  NO-PLATE referenceBox${tag}`);
    await sharp({ create: { width: C * 2, height: C + L, channels: 3, background: "#222" } })
      .composite([{ input: left, left: 0, top: 0 }, { input: right, left: C, top: 0 }]).jpeg({ quality: 90 })
      .toFile(join(OUT, `${sku}_compare${SUF}.jpg`));
    console.log("ok");
  } catch (e) {
    console.log("FAIL: " + e.message);
    if (String(e.message).includes("429")) { console.error("Rate-limited — stopping; re-run to resume."); break; }
  }
}
console.log(`\nDone → ${OUT}/  (*_noplate.jpg, *_compare.jpg, *_matte.png, *_shadow.jpg)`);
