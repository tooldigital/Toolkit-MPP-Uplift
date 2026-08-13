// EXPERIMENT — dark-gray cutout clean → clean RGB + clean ALPHA → composite over Photoroom shadow.
// New folder: outputs/experiments/cutout_darkgray/.  (Separate from hybrid_prshadow / dehalo.)
//
// Gemini cleans the matting fringe on the cutout flattened over DARK GRAY (#2A2A2A) — dark enough
// that the white fringe is visible (so Gemini removes it) but not so dark it re-tones the product
// (black does). From Gemini's dark-gray render we take, in a wide silhouette border:
//   - RGB   = Gemini's clean fur edge
//   - ALPHA = Gemini's coverage = distance from the dark-gray bg  (clean silhouette, no fat rim)
// The deep interior keeps the real matte (RGB + alpha). Then the normal pipeline composite runs
// over the PHOTOROOM shadow. Gemini's dark-gray background never leaks: where it's background,
// coverage→0, so the Photoroom shadow shows through.
//
// Reads matte.png + shadow.jpg (+ relit.jpg) from outputs/work/<sku>/. Writes:
//   <sku>_gemini_cut.jpg — RAW Gemini clean of the cutout-on-darkgray (4000²)   ← saved
//   <sku>_clean.jpg      — final: clean cutout over the Photoroom shadow         ← the result
//   <sku>_alpha.jpg      — the clean alpha (matte interior + Gemini edge coverage)
//   <sku>_sbs.jpg        — bottom-edge zoom: pipeline final | clean
//
//   node --env-file=.env scripts/exp_cutout_darkgray.mjs PE964848 [sku...] [--bg 2A2A2A] [--strength 0.08]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BG = arg("--bg", "2A2A2A").replace(/^#/, "");
const STRENGTH = parseFloat(arg("--strength", "0.08"));
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== BG && !/^[0-9.]+$/.test(a));
if (skus.length === 0) { console.error("usage: exp_cutout_darkgray.mjs <sku> [sku...]"); process.exit(1); }

const W = 4000;
const OUT = "outputs/experiments/cutout_darkgray";
const BGSWEEP = "outputs/experiments/cutout_bg";   // reuse a cached gem_<bg>.jpg if present
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);
function bbox(a, W, H, thr = 40) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }

const INSTRUCTION = `This is a plush / soft-toy product on a flat neutral DARK GREY background — no shadow.

Around the fuzzy fur silhouette there is a thin bright WHITE matting fringe left by background removal; it stands out against the dark grey. Remove ONLY that white fringe: recolor those edge pixels to match the adjacent fur color so the silhouette reads as clean fur meeting the dark grey.

- Keep the product body, its fur texture and color, pixel-for-pixel — do NOT restyle, re-expose or invent detail.
- Keep the dark grey background flat and unchanged.
- Do NOT move, rescale, re-crop or recompose. Product stays in the EXACT same position and scale.`;

const gR = parseInt(BG.slice(0, 2), 16), gG = parseInt(BG.slice(2, 4), 16), gB = parseInt(BG.slice(4, 6), 16);

for (const sku of skus) {
  process.stdout.write(`${sku} ... `);
  try {
    const dir = `outputs/work/${sku}`;
    const matteBytes = await readFile(join(dir, "matte.png"));
    const shadowBytes = await readFile(join(dir, "shadow.jpg"));
    const onGray = await sharp(matteBytes).resize(W, W).flatten({ background: `#${BG}` }).jpeg({ quality: 95 }).toBuffer();

    // Gemini clean on dark grey (cache-first; reuse the bg-sweep's cache if it exists).
    const gemPath = join(OUT, `${sku}_gemini_cut.jpg`);
    const sweepPath = join(BGSWEEP, `${sku}_gem_${BG}.jpg`);
    let gemBytes;
    if (await exists(gemPath)) gemBytes = await readFile(gemPath);
    else if (await exists(sweepPath)) { gemBytes = await readFile(sweepPath); await writeFile(gemPath, gemBytes); }
    else {
      const rawG = await generateShadowGemini({ apiKey: K, sku, image: onGray, instruction: INSTRUCTION, temperature: 0 });
      gemBytes = await sharp(rawG).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(gemPath, gemBytes);
    }

    const subj = await sharp(matteBytes).resize(W, W).removeAlpha().raw().toBuffer();
    const gem  = await sharp(gemBytes).resize(W, W).removeAlpha().raw().toBuffer();
    const A    = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const Ab   = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").blur(18).raw().toBuffer();
    const base = await sharp(shadowBytes).resize(W, W).removeAlpha().raw().toBuffer();
    const N = W * W;
    const raw = { raw: { width: W, height: W, channels: 3 } };

    const lm = new Float32Array(N);
    if (await exists(join(dir, "relit.jpg"))) {
      const g = await sharp(await readFile(join(dir, "relit.jpg"))).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
      for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(g[k], g[k + 1], g[k + 2]);
    }

    // Clean cutout: RGB + ALPHA from Gemini in the border, real matte in the interior.
    // Gemini coverage = distance of its pixel from the dark-grey bg (product = far, cleaned edge = near 0).
    const rgbClean = Buffer.alloc(N * 3);
    const aClean = new Float32Array(N);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const m  = 1 - smoothstep(0.72, 0.97, Ab[p] / 255);                                  // border weight
      const gd = Math.max(Math.abs(gem[i] - gR), Math.abs(gem[i + 1] - gG), Math.abs(gem[i + 2] - gB));
      const ag = smoothstep(18, 55, gd);                                                    // Gemini clean coverage
      aClean[p] = (A[p] / 255) * (1 - m) + ag * m;
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
    for (const [lbl, f] of [["pipeline final (rim)", join(dir, "final_FFFFFF.jpg")], [`cutout dark-grey #${BG}`, join(OUT, `${sku}_clean.jpg`)]]) {
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
