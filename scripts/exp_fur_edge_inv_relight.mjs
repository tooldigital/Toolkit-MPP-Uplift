// EXPERIMENT — relight applied at the VERY END to the inverse-mask composites (exp_fur_edge_inv).
// The inv comp is white-bg with outward strands past the matte silhouette, so relight is gated by a
// "non-white" product mask (not the matte alpha) — otherwise the wispy edges wouldn't get lit.
//   pmask = smoothstep(0.03, 0.15, 1 - min(r,g,b)/255)     (white bg → 0, plush/strands → 1)
//   factor = 1 + ((lm-mean)/128)*strength*pmask ; out = comp * factor
// lm = luma(blur(relit,20)); mean = alpha-weighted mean over the matte (same normalization as pipeline).
//
// Reads fur_edge/<sku>_comp_{A,B,C}_inv.jpg + work/<sku>/{matte,relit} (cached, no API). Writes
// <sku>_comp_{A,B,C}_inv_relit.jpg and a sheet: row1 inv (no relight), row2 inv +relight.
//
//   node scripts/exp_fur_edge_inv_relight.mjs PE964848 [sku...] [--strength 0.08]

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const STRENGTH = parseFloat(arg("--strength", "0.08"));
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--") && !/^[0-9.]+$/.test(a));
if (skus.length === 0) { console.error("usage: exp_fur_edge_inv_relight.mjs <sku> [sku...]"); process.exit(1); }

const W = 4000;
const DIR = "outputs/experiments/fur_edge";
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const LABEL = { A: "A recolor", B: "B +fine strands", C: "C +wispy" };

for (const sku of skus) {
  try {
    const work = `outputs/work/${sku}`;
    const matte = await readFile(join(work, "matte.png"));
    const relit = await readFile(join(work, "relit.jpg"));
    const a = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const gm = await sharp(relit).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
    const N = W * W;
    const lm = new Float32Array(N);
    for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(gm[k], gm[k + 1], gm[k + 2]);
    let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const av = a[p] / 255; gs += lm[p] * av; aw += av; }
    const mean = aw > 0 ? gs / aw : 128;

    const relitOf = {};
    for (const v of ["A", "B", "C"]) {
      const comp = await sharp(join(DIR, `${sku}_comp_${v}_inv.jpg`)).resize(W, W).removeAlpha().raw().toBuffer();
      const out = Buffer.alloc(N * 3);
      for (let p = 0, i = 0; p < N; p++, i += 3) {
        const cov = 1 - Math.min(comp[i], comp[i + 1], comp[i + 2]) / 255;   // non-white → product/strands
        const pmask = smoothstep(0.03, 0.15, cov);
        const f = 1 + ((lm[p] - mean) / 128) * STRENGTH * pmask;
        out[i] = clamp(comp[i] * f); out[i + 1] = clamp(comp[i + 1] * f); out[i + 2] = clamp(comp[i + 2] * f);
      }
      const buf = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(join(DIR, `${sku}_comp_${v}_inv_relit.jpg`), buf);
      relitOf[v] = buf;
    }

    const cellW = 560;
    const cap = (t) => Buffer.from(`<svg width="${W}" height="90"><rect width="100%" height="100%" fill="black"/><text x="24" y="66" font-family="monospace" font-size="54" fill="white">${t}</text></svg>`);
    const cell = async (src, t) => { const img = await sharp(src).resize(W, W).png().toBuffer(); const c = await sharp(img).composite([{ input: cap(t), top: 0, left: 0 }]).png().toBuffer(); return sharp(c).resize(cellW, null).png().toBuffer(); };
    const row0 = await Promise.all(["A", "B", "C"].map((v) => cell(join(DIR, `${sku}_comp_${v}_inv.jpg`), `inv-mask · ${LABEL[v]}`)));
    const row1 = await Promise.all(["A", "B", "C"].map((v) => cell(relitOf[v], `inv +relight ${STRENGTH} · ${LABEL[v]}`)));
    const rh = (await sharp(row0[0]).metadata()).height;
    const strip = (cells, top) => cells.map((pn, i) => ({ input: pn, left: i * (cellW + 6), top }));
    await sharp({ create: { width: (cellW + 6) * 3, height: rh * 2 + 6, channels: 3, background: "#222" } })
      .composite([...strip(row0, 0), ...strip(row1, rh + 6)])
      .jpeg({ quality: 92 }).toFile(join(DIR, `${sku}_inv_relit_sheet.jpg`));
    console.log(`ok ${sku} (mean=${mean.toFixed(1)}) → ${DIR}/${sku}_inv_relit_sheet.jpg`);
  } catch (e) {
    console.log(`FAIL ${sku}: ${e.message}`);
  }
}
