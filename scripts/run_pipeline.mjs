// MPP uplift pipeline — one SKU at a time.
//
//   node --env-file=.env scripts/run_pipeline.mjs [--skus a,b] [--bg FFFFFF] [--strength 0.25]
//
// Per SKU:  plate (place on canvas) → Photoroom cutout (matte) → Photoroom shadow (base)
//           → Gemini relight (lighting map) → composite → outputs/finals/<sku>.jpg
//
// The cast shadow comes straight from Photoroom's shadow output (relit in place, gated by
// the matte) — nothing re-registers or crops it. Resumable (skips finished SKUs) and
// Photoroom rate-limit aware (stops the stage on 429; re-run to resume).

import { mkdir, readdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import { makePlate, composeBackground } from "../src/plate.mjs";
import { cutout } from "../src/cutout.mjs";
import { generateShadow } from "../src/photoroom.mjs";
import { generateShadowGemini, RELIGHT_VARIANTS } from "../src/gemini.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BG = arg("--bg", "FFFFFF");
const STRENGTH = parseFloat(arg("--strength", "0.25"));
// Shadow preset. `long` = directional cast (dramatic, but diverges per-leg on legged furniture).
// `short` = soft grounding shadow (consistent, immune to per-leg wrong-direction). Cached separately
// (shadow_<preset>.jpg / relit_<preset>.jpg / final_<preset>_<bg>.jpg) so presets coexist per SKU.
const SHADOW = arg("--shadow", "long");
const SUF = SHADOW === "long" ? "" : `_${SHADOW}`;
const SHADOW_PARAMS = {
  long:  { mode: "ai.auto-with-overrides", softness: 0.6,  intensity: 0.55, spread: "long",  direction: "behindRight", subjectPose: "upright" },
  short: { mode: "ai.auto-with-overrides", softness: 0.75, intensity: 0.5,  spread: "short",                           subjectPose: "upright" },
}[SHADOW];
if (!SHADOW_PARAMS) { console.error(`unknown --shadow "${SHADOW}" (use long|short)`); process.exit(1); }
const SRC = "inputs";
const WORK = "outputs/work";                                  // per-SKU intermediates (cached)
const FINALS = arg("--out", "outputs/finals");                // flat folder of final images
const SHEET = arg("--sheet", "outputs/contact_sheet.jpg");    // contact sheet path
const W = 4000;
const prKey = process.env.PHOTOROOM_KEY, gemKey = process.env.GEMINI_KEY;
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
// tight bounding box of a 1-channel alpha buffer (pixels above thr)
function alphaBbox(a, W, H, thr = 128) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error("empty alpha (no subject)");
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => stat(p).then(() => true, () => false);

if (!prKey || !gemKey) { console.error("Set PHOTOROOM_KEY and GEMINI_KEY (in .env)."); process.exit(1); }

const only = arg("--skus", null);
let files = (await readdir(SRC)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
if (only) { const set = new Set(only.split(",")); files = files.filter((f) => set.has(basename(f, extname(f)))); }

await mkdir(WORK, { recursive: true });
await mkdir(FINALS, { recursive: true });
console.log(`Pipeline: ${files.length} SKUs · relight=gemini · strength=${STRENGTH} · bg=${BG}\n`);

const ok = [], failed = [];
for (let i = 0; i < files.length; i++) {
  const sku = basename(files[i], extname(files[i]));
  const dir = join(WORK, sku); await mkdir(dir, { recursive: true });
  const finalPath = join(dir, `final${SUF}_${BG}.jpg`);   // cache per shadow-preset + background
  process.stdout.write(`[${i + 1}/${files.length}] ${sku} ... `);
  if (await exists(finalPath)) { await copyFile(finalPath, join(FINALS, `${sku}.jpg`)); console.log("skip"); ok.push(sku); continue; }
  try {
    // 1. plate — place the subject on a 4000² white canvas (brief-spec framing)
    const { plate } = await makePlate({ source: join(SRC, files[i]) });
    const plateWhite = await composeBackground(plate, "FFFFFF");

    // 2. Photoroom shadow base — outputSize 4000², padding 0.10. Photoroom pads around the
    //    PRODUCT (400 px margin) and lets the cast shadow fall into the margin, so the product
    //    framing matches the matte exactly (verified: same product bbox within ~6 px) while the
    //    shadow still has room. Cached.
    const sp = join(dir, `shadow${SUF}.jpg`);
    let shadowBytes;
    if (await exists(sp)) shadowBytes = await readFile(sp);
    else { shadowBytes = await generateShadow({ apiKey: prKey, image: plateWhite, filename: `${sku}.jpg`, background: "FFFFFF", outputSize: "4000x4000", padding: 0.10, format: "jpeg", shadow: SHADOW_PARAMS }); await writeFile(sp, Buffer.from(shadowBytes)); await sleep(1100); }

    // 3. Matte — removeBackground(plateWhite, 4000², padding 0.10): crisp original pixels + alpha
    //    at the SAME product framing as the shadow base (both pad around the product). Cached.
    const ocp = join(dir, "matte.png");
    let matteBytes;
    if (await exists(ocp)) matteBytes = await readFile(ocp);
    else { matteBytes = await cutout({ apiKey: prKey, image: plateWhite, filename: `${sku}.png`, outputSize: "4000x4000", padding: 0.10 }); await writeFile(ocp, Buffer.from(matteBytes)); await sleep(1100); }
    const sAlpha = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();

    // 4. Gemini relight of the shadow base → LIGHTING MAP only (never pixels). Cached.
    //    Generated at 2K — requesting 4K makes the model tile/hallucinate texture (verified:
    //    same prompt is clean at 2K, tiles at 4K regardless of input size; see src/gemini.mjs).
    //    Upscaled to working res, then LOW-PASSED (blur) so only the smooth lighting gradient
    //    transfers to the composite — never Gemini texture, JPEG noise, or tiling residue.
    const rp = join(dir, `relit${SUF}.jpg`);
    let relit;
    if (await exists(rp)) relit = await readFile(rp);
    else { relit = await generateShadowGemini({ apiKey: gemKey, image: Buffer.from(shadowBytes), instruction: RELIGHT_VARIANTS.standard, temperature: 0 }); await writeFile(rp, Buffer.from(relit)); }
    const g = await sharp(relit).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
    const lm = new Float32Array(W * W); for (let p = 0, k = 0; p < lm.length; p++, k += 3) lm[p] = gray(g[k], g[k + 1], g[k + 2]);

    // 5. Composite — matte, original, and shadow all share ONE Photoroom frame, so NO alignment.
    //    Verified: matte product bbox == shadow product bbox (both fit-to-frame by Photoroom).
    //    - Subject = the MATTE itself (removeBackground returns the ORIGINAL crisp pixels + a straight
    //      anti-aliased alpha). Kept straight (NOT flattened) so the edge decontaminates onto ANY bg.
    //    - Background = `bg` darkened by the cast shadow: shadowFactor = luminance of the shadow-on-
    //      white base / 255 (1 = no shadow, <1 = shadow). The product's own darkness is masked out of
    //      that factor via the alpha, so a non-white bg gets no dark edge halo. For white bg this
    //      reduces exactly to the original shadow base.
    //    - Relight is the shadow-base lightmap (same frame), applied to the product only.
    const subj = await sharp(matteBytes).resize(W, W).removeAlpha().raw().toBuffer();   // straight RGB
    const base = await sharp(Buffer.from(shadowBytes)).resize(W, W).removeAlpha().raw().toBuffer();
    const bgR = parseInt(BG.slice(0, 2), 16), bgG = parseInt(BG.slice(2, 4), 16), bgB = parseInt(BG.slice(4, 6), 16);
    let gs = 0, aw = 0; for (let p = 0; p < lm.length; p++) { const a = sAlpha[p] / 255; gs += lm[p] * a; aw += a; }
    const mean = aw > 0 ? gs / aw : 128;
    const out = Buffer.alloc(W * W * 3);
    for (let p = 0, i2 = 0; p < lm.length; p++, i2 += 3) {
      const a = sAlpha[p] / 255;                            // crisp subject coverage
      const f = 1 + ((lm[p] - mean) / 128) * STRENGTH;      // gentle directional relight
      // cast-shadow darkening of the chosen bg; product region (a→1) excluded so no edge halo
      const sf = (a * 255 + (1 - a) * gray(base[i2], base[i2 + 1], base[i2 + 2])) / 255;
      const br = bgR * sf, bg2 = bgG * sf, bb2 = bgB * sf;
      out[i2] = clamp(subj[i2] * f * a + br * (1 - a));
      out[i2 + 1] = clamp(subj[i2 + 1] * f * a + bg2 * (1 - a));
      out[i2 + 2] = clamp(subj[i2 + 2] * f * a + bb2 * (1 - a));
    }
    // Padding (400 px margin) already comes from Photoroom's padding:0.10 framing — write as-is.
    await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toFile(finalPath);
    await copyFile(finalPath, join(FINALS, `${sku}.jpg`));
    console.log("ok"); ok.push(sku);
  } catch (e) {
    console.log("FAIL: " + e.message); failed.push(sku);
    if (String(e.message).includes("429")) { console.error("Rate-limited — stopping; re-run to resume."); break; }
  }
}

// contact sheet of all finals
const cells = [];
for (const sku of ok) {
  const p = join(FINALS, `${sku}.jpg`); if (!(await exists(p))) continue;
  const C = 300, L = 22;
  const img = await sharp(p).resize(C, C, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).toBuffer();
  const lbl = Buffer.from(`<svg width="${C}" height="${L}"><rect width="100%" height="100%" fill="black"/><text x="6" y="16" font-family="monospace" font-size="12" fill="white">${sku}</text></svg>`);
  cells.push(await sharp({ create: { width: C, height: C + L, channels: 3, background: "#000" } }).composite([{ input: img, top: L, left: 0 }, { input: lbl, top: 0, left: 0 }]).png().toBuffer());
}
if (cells.length) {
  const C = 300, L = 22, COLS = 6, ROWS = Math.ceil(cells.length / COLS);
  await sharp({ create: { width: C * COLS, height: (C + L) * ROWS, channels: 3, background: "#222" } })
    .composite(cells.map((c, i) => ({ input: c, left: (i % COLS) * C, top: Math.floor(i / COLS) * (C + L) }))).jpeg({ quality: 88 })
    .toFile(SHEET);
  console.log(`\ncontact sheet → ${SHEET}`);
}
console.log(`\nDone. ${ok.length} ok, ${failed.length} failed${failed.length ? ": " + failed.join(", ") : ""}`);
console.log(`Finals: outputs/finals/  (flat, one image per SKU)`);
