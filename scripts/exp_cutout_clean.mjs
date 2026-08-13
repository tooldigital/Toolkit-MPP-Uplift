// EXPERIMENT — apply the dehalo edge to the CUTOUT (RGB *and* alpha), THEN composite over the
// Photoroom shadow. Separate folder: outputs/experiments/cutout_clean/.
//
// The dehalo/hybrid that worked used Gemini's clean silhouette. Earlier cutout attempts failed
// because they cleaned only the RGB and kept the matte's TOO-GENEROUS alpha, so the rim came back
// in the composite. The fix (this script): build a clean cutout whose EDGE — both color and
// COVERAGE — comes from Gemini, then run the normal pipeline composite over the Photoroom shadow.
//
//   clean cutout, in the silhouette border:  rgb = Gemini,  alpha = Gemini coverage (clean edge)
//                             deep interior:  rgb = matte,   alpha = matte  (real product)
//   final = rgb*a + photoroomShadow*(1-a)     ← Photoroom shadow only; Gemini never drawn on the floor
//
// The rim pixels are near-white background the matte kept as partial foreground; Gemini renders
// them as background (coverage→0), so with Gemini's alpha they drop out and the shadow shows
// through — no rim, no gray halo, no reconstruction tricks.
//
// Reads matte.png + shadow.jpg (+ relit.jpg) from outputs/work/<sku>/. Writes:
//   <sku>_gemini_cut.jpg — RAW Gemini fringe-clean of the cutout-on-white (4000²)   ← saved
//   <sku>_clean.jpg      — final: clean cutout composited over the Photoroom shadow  ← the result
//   <sku>_alpha.jpg      — the clean alpha (matte interior + Gemini edge coverage)
//   <sku>_sbs.jpg        — bottom-edge zoom: pipeline final | clean
//
//   node --env-file=.env scripts/exp_cutout_clean.mjs PE964848 [sku...] [--strength 0.08]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const STRENGTH = parseFloat(arg("--strength", "0.08"));
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--") && !/^\d/.test(a));
if (skus.length === 0) { console.error("usage: exp_cutout_clean.mjs <sku> [sku...]"); process.exit(1); }

const W = 4000;
const OUT = "outputs/experiments/cutout_clean";
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);
function bbox(a, W, H, thr = 40) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }

const CLEAN_INSTRUCTION = `This is a plush / soft-toy product on a pure white background — no shadow.

Around the fuzzy fur silhouette there is a thin white matting fringe left by background removal. Redraw the silhouette as clean fur meeting the white background — crisp fur tips, no bright halo, no grey smear.

- Keep the product body, its fur texture and color, pixel-for-pixel.
- Keep the background pure white.
- Do NOT move, rescale, re-crop or recompose. Product stays in the EXACT same position and scale.`;

for (const sku of skus) {
  process.stdout.write(`${sku} ... `);
  try {
    const dir = `outputs/work/${sku}`;
    const matteBytes = await readFile(join(dir, "matte.png"));
    const shadowBytes = await readFile(join(dir, "shadow.jpg"));
    const matteOnWhite = await sharp(matteBytes).resize(W, W).flatten({ background: "#ffffff" }).jpeg({ quality: 95 }).toBuffer();

    // Gemini clean of the cutout-on-white (cache-first).
    const gemPath = join(OUT, `${sku}_gemini_cut.jpg`);
    let gemBytes;
    if (await exists(gemPath)) gemBytes = await readFile(gemPath);
    else {
      const rawG = await generateShadowGemini({ apiKey: K, sku, image: matteOnWhite, instruction: CLEAN_INSTRUCTION, temperature: 0 });
      gemBytes = await sharp(rawG).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(gemPath, gemBytes);
    }

    const subj = await sharp(matteBytes).resize(W, W).removeAlpha().raw().toBuffer();          // matte RGB
    const gem  = await sharp(gemBytes).resize(W, W).removeAlpha().raw().toBuffer();              // Gemini-cleaned product on white
    const A    = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const Ab   = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").blur(18).raw().toBuffer();
    const base = await sharp(shadowBytes).resize(W, W).removeAlpha().raw().toBuffer();           // Photoroom shadow render
    const N = W * W;
    const raw = { raw: { width: W, height: W, channels: 3 } };

    const lm = new Float32Array(N);
    if (await exists(join(dir, "relit.jpg"))) {
      const g = await sharp(await readFile(join(dir, "relit.jpg"))).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
      for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(g[k], g[k + 1], g[k + 2]);
    }

    // Clean cutout: RGB + ALPHA. In the border, both come from Gemini (clean edge + clean coverage);
    // in the deep interior, both are the real matte. Gemini coverage = how non-white its pixel is.
    const rgbClean = Buffer.alloc(N * 3);
    const aClean = new Float32Array(N);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const m  = 1 - smoothstep(0.72, 0.97, Ab[p] / 255);                            // border weight
      const ag = 1 - smoothstep(236, 253, gray(gem[i], gem[i + 1], gem[i + 2]));      // Gemini's clean coverage
      aClean[p] = (A[p] / 255) * (1 - m) + ag * m;                                    // matte inside, Gemini edge in border
      for (let c = 0; c < 3; c++) rgbClean[i + c] = clamp(subj[i + c] * (1 - m) + gem[i + c] * m);
    }
    await sharp(Buffer.from(aClean.map((v) => clamp(v * 255))), { raw: { width: W, height: W, channels: 1 } }).jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_alpha.jpg`));

    // Normal pipeline composite (white bg) over the Photoroom shadow, using the CLEAN cutout.
    let gs = 0, aw = 0; for (let p = 0; p < N; p++) { gs += lm[p] * aClean[p]; aw += aClean[p]; }
    const mean = aw > 0 ? gs / aw : 128;
    const out = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const a = aClean[p];
      const f = 1 + ((lm[p] - mean) / 128) * STRENGTH;
      const sf = (a * 255 + (1 - a) * gray(base[i], base[i + 1], base[i + 2])) / 255;
      const br = 255 * sf;
      out[i]     = clamp(rgbClean[i]     * f * a + br * (1 - a));
      out[i + 1] = clamp(rgbClean[i + 1] * f * a + br * (1 - a));
      out[i + 2] = clamp(rgbClean[i + 2] * f * a + br * (1 - a));
    }
    await sharp(out, raw).jpeg({ quality: 95 }).toFile(join(OUT, `${sku}_clean.jpg`));

    // bottom-edge comparison
    const bb = bbox(A, W, W, 40);
    const cw = 1200, ch = 560;
    const ex = { left: Math.min(Math.max(0, (bb.x0 * 2 + bb.w) / 2 - cw / 2), W - cw) | 0,
                 top:  Math.min(Math.max(0, bb.y0 + bb.h - ch + 150), W - ch) | 0, width: cw, height: ch };
    const cellW = 620, panels = [];
    for (const [lbl, f] of [["pipeline final (rim)", join(dir, "final_FFFFFF.jpg")], ["cutout_clean (photoroom shadow)", join(OUT, `${sku}_clean.jpg`)]]) {
      const im = await sharp(f).resize(W, W).extract(ex).png().toBuffer();
      const cap = Buffer.from(`<svg width="${cw}" height="20"><rect width="100%" height="100%" fill="black"/><text x="6" y="15" font-family="monospace" font-size="13" fill="white">${lbl}</text></svg>`);
      const cell = await sharp({ create: { width: cw, height: ch + 20, channels: 3, background: "#000" } }).composite([{ input: im, top: 20, left: 0 }, { input: cap, top: 0, left: 0 }]).png().toBuffer();
      panels.push(await sharp(cell).resize(cellW, null).png().toBuffer());
    }
    const ph = (await sharp(panels[0]).metadata()).height;
    await sharp({ create: { width: (cellW + 6) * panels.length, height: ph, channels: 3, background: "#222" } })
      .composite(panels.map((pn, i) => ({ input: pn, left: i * (cellW + 6), top: 0 }))).jpeg({ quality: 93 }).toFile(join(OUT, `${sku}_sbs.jpg`));

    console.log(`ok  → ${OUT}/${sku}_{gemini_cut,clean,alpha,sbs}.jpg`);
  } catch (e) {
    console.log("FAIL: " + e.message);
  }
}
