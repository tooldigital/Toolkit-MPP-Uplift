// EXPERIMENT — clean the white fringe on the CUTOUT with Gemini, BEFORE shadow + lighting.
// Separate from the pipeline; writes only to outputs/experiments/edgeclean/.
//
// Different tack from exp_dehalo.mjs. There, Gemini ran on the FINISHED composite (which already
// has the Photoroom cast shadow) — Gemini deleted the shadow, so we had to re-inject it. Here
// Gemini never sees a shadow: it cleans the fringe on the matte-on-white, and then the NORMAL
// pipeline composite runs over the untouched Photoroom shadow. So:
//   - cast shadow = Photoroom's, 100% native (invariant 4 intact — Gemini never touches it)
//   - the white rim is gone because the composite's `subj` is no longer white at the edge
//   - the face stays real: Gemini's pixels are used ONLY in a wide silhouette border (same mask
//     idea as the hybrid); the deep interior keeps the original cutout.
//
// Reads cached matte.png + shadow.jpg (+ relit.jpg if present) from outputs/work/<sku>/. Writes:
//   <sku>_gemini_cut.jpg — RAW Gemini fringe-clean of the matte-on-white (4000²)      ← saved
//   <sku>_cleaned.jpg    — final: cleaned cutout composited over the PHOTOROOM shadow  ← the result
//   <sku>_mask.jpg       — wide-border mask (white = use Gemini edge, black = keep original)
//   <sku>_sbs.jpg        — bottom-edge zoom: pipeline final (before) | cleaned
//
//   node --env-file=.env scripts/exp_edgeclean.mjs PE964848 [sku...] [--strength 0.08]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const STRENGTH = parseFloat(arg("--strength", "0.08"));   // relight strength (plush default)
// Background Gemini SEES the cutout on. The white fringe is invisible on white (white-on-white),
// so Gemini can't clean it — it must be shown on a neutral GRAY where the fringe stands out.
// This is only the cleaning INPUT; the final still composites over the Photoroom shadow on white.
const GEMBG = arg("--gembg", "8C8C8C").replace(/^#/, "");
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--") && !/^\d/.test(a));
if (skus.length === 0) { console.error("usage: exp_edgeclean.mjs <sku> [sku...] [--strength 0.08]"); process.exit(1); }

const W = 4000;
const OUT = "outputs/experiments/edgeclean";
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);
function bbox(a, W, H, thr = 40) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }

// Cleaning prompt for the matte-on-GRAY — NO shadow mentioned (there is none to protect).
// On gray the white matting fringe is clearly visible, so Gemini can actually target it.
const CLEAN_INSTRUCTION = `This is a plush / soft-toy product on a flat neutral GRAY background — no shadow.

There is a thin bright WHITE / light fringe of pixels all around the fuzzy fur silhouette, left by background removal — it stands out against the gray. Remove ONLY that white fringe: recolor those edge pixels to match the adjacent fur color so the silhouette reads as clean fur meeting the gray.

- Keep the product body, its fur texture and color, pixel-for-pixel.
- Keep the gray background flat and unchanged.
- Do NOT move, rescale, re-crop or recompose. Product stays in the EXACT same position and scale.`;

for (const sku of skus) {
  process.stdout.write(`${sku} ... `);
  try {
    const dir = `outputs/work/${sku}`;
    const matteBytes = await readFile(join(dir, "matte.png"));
    const shadowBytes = await readFile(join(dir, "shadow.jpg"));

    // matte-on-GRAY (what Gemini cleans): flatten the cutout onto neutral gray so the white
    // fringe is visible (it's invisible on white). No shadow — nothing for Gemini to delete.
    const matteOnGray = await sharp(matteBytes).resize(W, W).flatten({ background: `#${GEMBG}` }).jpeg({ quality: 95 }).toBuffer();

    // --- Gemini fringe-clean of the cutout (2K, temp 0), saved raw. Cache-first. ---
    const gemPath = join(OUT, `${sku}_gemini_cut.jpg`);
    let gemBytes;
    if (await exists(gemPath)) gemBytes = await readFile(gemPath);
    else {
      const rawG = await generateShadowGemini({ apiKey: K, sku, image: matteOnGray, instruction: CLEAN_INSTRUCTION, temperature: 0 });
      gemBytes = await sharp(rawG).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(gemPath, gemBytes);
    }

    // --- Load working buffers ---
    const subj = await sharp(matteBytes).resize(W, W).removeAlpha().raw().toBuffer();          // original cutout RGB (spilled edge)
    const gem  = await sharp(gemBytes).resize(W, W).removeAlpha().raw().toBuffer();              // Gemini-cleaned RGB
    const A    = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const Ab   = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").blur(18).raw().toBuffer();
    const base = await sharp(shadowBytes).resize(W, W).removeAlpha().raw().toBuffer();           // Photoroom shadow render
    const N = W * W;
    const raw = { raw: { width: W, height: W, channels: 3 } };

    // --- Relight lightmap (reuse cached relit if present; else flat) — matches the pipeline ---
    const lm = new Float32Array(N);
    if (await exists(join(dir, "relit.jpg"))) {
      const g = await sharp(await readFile(join(dir, "relit.jpg"))).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
      for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(g[k], g[k + 1], g[k + 2]);
    }

    // --- Cleaned subject + CORRECTED alpha, both from Gemini's gray render. ---
    //   RGB : Gemini's edge in a WIDE silhouette border, original in the deep interior (face real).
    //   ALPHA: where Gemini repainted the fringe back to GRAY, that pixel is background — so its
    //          matte alpha was too generous. Measure "product-ness" = distance from the gray bg;
    //          near 0 (gemini said gray) drops the coverage so the Photoroom shadow shows through
    //          instead of a light halo. This is the piece RGB-cleaning alone can't fix.
    const gR = parseInt(GEMBG.slice(0, 2), 16), gG = parseInt(GEMBG.slice(2, 4), 16), gB = parseInt(GEMBG.slice(4, 6), 16);
    const subjClean = Buffer.alloc(N * 3);
    const aEff = new Float32Array(N);
    const maskImg = Buffer.alloc(N);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const m = 1 - smoothstep(0.72, 0.97, Ab[p] / 255);   // 1 = border (trust Gemini), 0 = interior (trust matte)
      maskImg[p] = clamp(m * 255);
      for (let c = 0; c < 3; c++) subjClean[i + c] = clamp(subj[i + c] * (1 - m) + gem[i + c] * m);
      const gd = Math.max(Math.abs(gem[i] - gR), Math.abs(gem[i + 1] - gG), Math.abs(gem[i + 2] - gB)); // dist from gray
      const cov = smoothstep(12, 45, gd);                  // 1 = clearly product, 0 = gemini painted it gray
      aEff[p] = (A[p] / 255) * (1 - m * (1 - cov));         // in the border, drop coverage where gemini said "gray"
    }
    await sharp(maskImg, { raw: { width: W, height: W, channels: 1 } }).jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_mask.jpg`));

    // --- NORMAL pipeline composite (white bg) over the PHOTOROOM shadow, with corrected alpha ---
    let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const a = aEff[p]; gs += lm[p] * a; aw += a; }
    const mean = aw > 0 ? gs / aw : 128;
    const out = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const a = aEff[p];
      const f = 1 + ((lm[p] - mean) / 128) * STRENGTH;
      const sf = (a * 255 + (1 - a) * gray(base[i], base[i + 1], base[i + 2])) / 255;   // Photoroom cast shadow
      const br = 255 * sf;                                                              // white bg, shadow-darkened
      out[i]     = clamp(subjClean[i]     * f * a + br * (1 - a));
      out[i + 1] = clamp(subjClean[i + 1] * f * a + br * (1 - a));
      out[i + 2] = clamp(subjClean[i + 2] * f * a + br * (1 - a));
    }
    await sharp(out, raw).jpeg({ quality: 95 }).toFile(join(OUT, `${sku}_cleaned.jpg`));

    // --- DESPILL (Gemini-FREE control) — the rim is an ALPHA problem, so fix the alpha directly:
    //     where an original-matte fringe pixel is near-WHITE (spill, not fur), knock its coverage
    //     down in the silhouette band so the Photoroom shadow shows through. No API call. This is
    //     the one that actually removes the rim (see the 4-way diag); RGB-cleaning above does not.
    const despill = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const m = 1 - smoothstep(0.72, 0.97, Ab[p] / 255);
      const w = smoothstep(235, 252, gray(subj[i], subj[i + 1], subj[i + 2]));
      const a = (A[p] / 255) * (1 - w * Math.min(1, m * 3));
      const fct = 1 + ((lm[p] - mean) / 128) * STRENGTH;
      const sf = (a * 255 + (1 - a) * gray(base[i], base[i + 1], base[i + 2])) / 255;
      const br = 255 * sf;
      despill[i]     = clamp(subj[i]     * fct * a + br * (1 - a));
      despill[i + 1] = clamp(subj[i + 1] * fct * a + br * (1 - a));
      despill[i + 2] = clamp(subj[i + 2] * fct * a + br * (1 - a));
    }
    await sharp(despill, raw).jpeg({ quality: 95 }).toFile(join(OUT, `${sku}_despill.jpg`));

    // --- bottom-edge comparison: pipeline final (before) | gemini edge-clean | despill ---
    const bb = bbox(A, W, W, 40);
    const cw = 1400, ch = 600;
    const ex = { left: Math.min(Math.max(0, (bb.x0 * 2 + bb.w) / 2 - cw / 2), W - cw) | 0,
                 top:  Math.min(Math.max(0, bb.y0 + bb.h - ch + 170), W - ch) | 0, width: cw, height: ch };
    const cellW = 480, panels = [];
    for (const [lbl, f] of [["pipeline final (white rim)", join(dir, "final_FFFFFF.jpg")], ["gemini edge-clean (rim survives)", join(OUT, `${sku}_cleaned.jpg`)], ["despill, no gemini (rim gone)", join(OUT, `${sku}_despill.jpg`)]]) {
      const img = await sharp(await sharp(f).resize(W, W).extract(ex).toBuffer()).resize(cellW, null).png().toBuffer();
      const h = (await sharp(img).metadata()).height;
      const cap = Buffer.from(`<svg width="${cellW}" height="20"><rect width="100%" height="100%" fill="black"/><text x="6" y="15" font-family="monospace" font-size="12" fill="white">${lbl}</text></svg>`);
      panels.push(await sharp({ create: { width: cellW, height: h + 20, channels: 3, background: "#000" } }).composite([{ input: img, top: 20, left: 0 }, { input: cap, top: 0, left: 0 }]).png().toBuffer());
    }
    const ph = (await sharp(panels[0]).metadata()).height;
    await sharp({ create: { width: (cellW + 6) * panels.length, height: ph, channels: 3, background: "#222" } })
      .composite(panels.map((pn, i) => ({ input: pn, left: i * (cellW + 6), top: 0 }))).jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_sbs.jpg`));

    console.log(`ok  → ${OUT}/${sku}_{gemini_cut,cleaned,despill,mask,sbs}.jpg`);
  } catch (e) {
    console.log("FAIL: " + e.message);
  }
}
