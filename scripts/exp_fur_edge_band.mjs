// EXPERIMENT — like exp_fur_edge_inv, but sweep a MUCH WIDER Gemini band that reaches inward from
// the silhouette, so Gemini's fur cleanup is incorporated over a thick rim (not just the alpha edge)
// and any residual matting halo just inside the edge is overwritten.
//   w   = 1 - smoothstep(0.15, 0.85, blur(alpha, R) / 255)     (R = band width; bigger = wider)
//   out = subj*(1-w) + gem*w        (subj = real matte product, gem = Gemini output; WHITE bg)
// Deep interior (blurred-alpha≈1) → real product; wide border band → Gemini fur; outside → gem bg+strands.
//
// Sweeps R ∈ {25, 80, 160, 300}. Reads work/<sku>/matte.png + fur_edge/<sku>_gem_<GEM>.jpg (cached,
// no API). Writes <sku>_band_<R>.jpg and a per-SKU sheet: row1 full frame, row2 top-edge crop.
//
//   node scripts/exp_fur_edge_band.mjs PE964848 [sku...] [--gem B]

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const GEM = arg("--gem", "B").toUpperCase();
const skus = process.argv.slice(2).filter((a) => /^PE/i.test(a));
const RADII = [40, 90, 160, 240];

if (skus.length === 0) { console.error("usage: exp_fur_edge_band.mjs <sku> [sku...] [--gem A|B|C]"); process.exit(1); }

const W = 4000;
const DIR = "outputs/experiments/fur_edge";
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
function bbox(a, W, H, thr = 40) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }

for (const sku of skus) {
  try {
    const matte = await readFile(join(`outputs/work/${sku}`, "matte.png"));
    const subj = await sharp(matte).resize(W, W).removeAlpha().raw().toBuffer();
    const a    = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const gem  = await sharp(join(DIR, `${sku}_gem_${GEM}.jpg`)).resize(W, W).removeAlpha().raw().toBuffer();
    const N = W * W;

    const compOf = {};
    for (const R of RADII) {
      const Ab = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(R).raw().toBuffer();
      const out = Buffer.alloc(N * 3);
      for (let p = 0, i = 0; p < N; p++, i += 3) {
        // I = interior selector: 1 deep inside, 0 across the band + outside (band width set by R).
        const I = smoothstep(0.55, 0.92, Ab[p] / 255);
        // real product shows ONLY deep inside AND where the crisp alpha is solid — the `a` gate makes
        // subj hard-zero outside the true silhouette, so the matte's dark out-of-subject RGB can't
        // bleed into the widening band (that was the grey-halo bug). Elsewhere → gem.
        const pw = (a[p] / 255) * I;
        for (let c = 0; c < 3; c++) out[i + c] = clamp(subj[i + c] * pw + gem[i + c] * (1 - pw));
      }
      const buf = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(join(DIR, `${sku}_band_${R}.jpg`), buf);
      compOf[R] = buf;
    }

    // sheet: row1 full frame, row2 top-edge crop, columns = band widths
    const bb = bbox(a, W, W, 40);
    const cw = 1100, ch = 900, cx = (bb.x0 + bb.w / 2) | 0;
    const ex = { left: Math.min(Math.max(0, cx - cw / 2), W - cw) | 0, top: Math.min(Math.max(0, bb.y0 - 60), W - ch) | 0, width: cw, height: ch };
    const cellW = 460;
    const cap = (w, t, fs) => Buffer.from(`<svg width="${w}" height="${fs + 14}"><rect width="100%" height="100%" fill="black"/><text x="10" y="${fs + 4}" font-family="monospace" font-size="${fs}" fill="white">${t}</text></svg>`);
    const full = async (buf, t) => { const img = await sharp(buf).resize(W, W).png().toBuffer(); const c = await sharp(img).composite([{ input: cap(W, t, 60), top: 0, left: 0 }]).png().toBuffer(); return sharp(c).resize(cellW, null).png().toBuffer(); };
    const crop = async (buf, t) => { const img = await sharp(buf).resize(W, W).extract(ex).png().toBuffer(); const c = await sharp({ create: { width: cw, height: ch + 30, channels: 3, background: "#000" } }).composite([{ input: img, top: 30, left: 0 }, { input: cap(cw, t, 22), top: 0, left: 0 }]).png().toBuffer(); return sharp(c).resize(cellW, null).png().toBuffer(); };
    const row0 = await Promise.all(RADII.map((R) => full(compOf[R], `band R=${R} · gem ${GEM}`)));
    const row1 = await Promise.all(RADII.map((R) => crop(compOf[R], `R=${R}`)));
    const h0 = (await sharp(row0[0]).metadata()).height, h1 = (await sharp(row1[0]).metadata()).height;
    const strip = (cells, top) => cells.map((pn, i) => ({ input: pn, left: i * (cellW + 6), top }));
    await sharp({ create: { width: (cellW + 6) * RADII.length, height: h0 + h1 + 6, channels: 3, background: "#222" } })
      .composite([...strip(row0, 0), ...strip(row1, h0 + 6)])
      .jpeg({ quality: 92 }).toFile(join(DIR, `${sku}_band_sheet.jpg`));
    console.log(`ok ${sku} (gem ${GEM}) → ${DIR}/${sku}_band_sheet.jpg`);
  } catch (e) {
    console.log(`FAIL ${sku}: ${e.message}`);
  }
}
