// EXPERIMENT — glass composite as a straight cutout over the Photoroom render,
// WITH the pipeline's gentle relight applied to the product only.
//   out = subj*f*A + base*(1-A)
//   A = matte alpha (hard paste mask); f = 1 + ((lm-mean)/128)*STRENGTH (lightmap)
// Reuses cached matte.png + shadow.jpg; generates+caches relit.jpg via Gemini if missing.
// Writes finals only to outputs/experiments/.  Run with:  node --env-file=.env scripts/exp_subj_over_base.mjs
import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { generateShadowGemini, RELIGHT_VARIANTS } from "../src/gemini.mjs";

const W = 4000;
const STRENGTH = 0.25;
const SKUS = ["PE842382", "PE962684", "PE988680", "PE988681"];
const WORK = "outputs/work";
const OUT = "outputs/experiments/glass_subj_over_base_relit";
const gemKey = process.env.GEMINI_KEY;
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

await mkdir(OUT, { recursive: true });
const cells = [];
for (const sku of SKUS) {
  const dir = join(WORK, sku);
  const matte = join(dir, "matte.png");
  const shadow = join(dir, "shadow.jpg");

  // relit lightmap source — reuse cache, else generate (2K, temp 0) and cache like the pipeline
  const rp = join(dir, "relit.jpg");
  let relit;
  if (existsSync(rp)) { relit = await readFile(rp); }
  else {
    if (!gemKey) throw new Error(`no relit cache for ${sku} and GEMINI_KEY unset (run with --env-file=.env)`);
    console.log("gemini relight →", sku);
    const shadowBytes = await readFile(shadow);
    relit = await generateShadowGemini({ apiKey: gemKey, image: shadowBytes, instruction: RELIGHT_VARIANTS.standard, temperature: 0 });
    await writeFile(rp, Buffer.from(relit));
  }

  const subj = await sharp(matte).resize(W, W).removeAlpha().raw().toBuffer();
  const alpha = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  const base = await sharp(shadow).resize(W, W).removeAlpha().raw().toBuffer();

  // lightmap: upscale to W, low-pass, grayscale (same as pipeline)
  const g = await sharp(relit).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
  const lm = new Float32Array(W * W);
  for (let p = 0, k = 0; p < lm.length; p++, k += 3) lm[p] = gray(g[k], g[k + 1], g[k + 2]);

  // alpha-weighted mean over the subject
  let gs = 0, aw = 0;
  for (let p = 0; p < lm.length; p++) { const a = alpha[p] / 255; gs += lm[p] * a; aw += a; }
  const mean = aw > 0 ? gs / aw : 128;

  const out = Buffer.alloc(W * W * 3);
  for (let p = 0, i = 0; p < lm.length; p++, i += 3) {
    const a = alpha[p] / 255;
    const f = 1 + ((lm[p] - mean) / 128) * STRENGTH;   // relight, product only
    out[i]     = clamp(subj[i]     * f * a + base[i]     * (1 - a));
    out[i + 1] = clamp(subj[i + 1] * f * a + base[i + 1] * (1 - a));
    out[i + 2] = clamp(subj[i + 2] * f * a + base[i + 2] * (1 - a));
  }
  const path = join(OUT, `${sku}.jpg`);
  await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toFile(path);
  console.log("wrote", path);

  const C = 480, L = 24;
  const img = await sharp(path).resize(C, C, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).toBuffer();
  const lbl = await sharp({ text: { text: sku, font: "sans", rgba: true, width: C, height: L } }).png().toBuffer();
  cells.push(await sharp({ create: { width: C, height: C + L, channels: 3, background: "#000" } })
    .composite([{ input: img, top: L, left: 0 }, { input: lbl, top: 2, left: 4 }]).png().toBuffer());
}
const C = 480, L = 24;
await sharp({ create: { width: C * SKUS.length, height: C + L, channels: 3, background: "#000" } })
  .composite(cells.map((c, i) => ({ input: c, left: i * C, top: 0 }))).jpeg({ quality: 90 })
  .toFile(join(OUT, "contact_sheet.jpg"));
console.log("contact sheet →", join(OUT, "contact_sheet.jpg"));
