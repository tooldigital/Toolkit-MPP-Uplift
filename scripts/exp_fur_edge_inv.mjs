// EXPERIMENT — inverse-mask composite: real crisp product INSIDE the plush, Gemini's whole output
// (feathered edges + strands + white bg) brought in AROUND it via the inverse matte mask.
//   out = subj*a + gem*(1-a)          (subj = matte straight RGB, a = matte alpha, gem = Gemini output)
// This keeps Gemini's outward wisps (they live where a→0). WHITE bg only; the Photoroom cast shadow
// is NOT used here (gem's background is plain white with the shadow removed).
//
// Reads work/<sku>/matte.png + fur_edge/<sku>_gem_{A,B,C}.jpg (all cached, no API). Writes
// <sku>_comp_{A,B,C}_inv.jpg and a per-SKU sheet: row1 full frame A|B|C, row2 top-edge crop A|B|C.
//
//   node scripts/exp_fur_edge_inv.mjs PE964848 [sku...]

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const skus = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (skus.length === 0) { console.error("usage: exp_fur_edge_inv.mjs <sku> [sku...]"); process.exit(1); }

const W = 4000;
const DIR = "outputs/experiments/fur_edge";
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
function bbox(a, W, H, thr = 40) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }
const LABEL = { A: "A recolor", B: "B +fine strands", C: "C +wispy" };

for (const sku of skus) {
  try {
    const matte = await readFile(join(`outputs/work/${sku}`, "matte.png"));
    const subj = await sharp(matte).resize(W, W).removeAlpha().raw().toBuffer();          // real crisp product RGB
    const a    = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const N = W * W;
    const compOf = {};
    for (const v of ["A", "B", "C"]) {
      const gem = await sharp(join(DIR, `${sku}_gem_${v}.jpg`)).resize(W, W).removeAlpha().raw().toBuffer();
      const out = Buffer.alloc(N * 3);
      for (let p = 0, i = 0; p < N; p++, i += 3) {
        const av = a[p] / 255;                                  // crisp coverage: inside=product, outside=gem
        for (let c = 0; c < 3; c++) out[i + c] = clamp(subj[i + c] * av + gem[i + c] * (1 - av));
      }
      const buf = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(join(DIR, `${sku}_comp_${v}_inv.jpg`), buf);
      compOf[v] = buf;
    }

    // sheet: row1 full frame, row2 top-edge crop
    const bb = bbox(a, W, W, 40);
    const cw = 1100, ch = 900, cx = (bb.x0 + bb.w / 2) | 0;
    const ex = { left: Math.min(Math.max(0, cx - cw / 2), W - cw) | 0, top: Math.min(Math.max(0, bb.y0 - 60), W - ch) | 0, width: cw, height: ch };
    const cellW = 560;
    const cap = (w, t, fs) => Buffer.from(`<svg width="${w}" height="${fs + 14}"><rect width="100%" height="100%" fill="black"/><text x="10" y="${fs + 4}" font-family="monospace" font-size="${fs}" fill="white">${t}</text></svg>`);
    const full = async (buf, t) => { const img = await sharp(buf).resize(W, W).png().toBuffer(); const c = await sharp(img).composite([{ input: cap(W, t, 54), top: 0, left: 0 }]).png().toBuffer(); return sharp(c).resize(cellW, null).png().toBuffer(); };
    const crop = async (buf, t) => { const img = await sharp(buf).resize(W, W).extract(ex).png().toBuffer(); const c = await sharp({ create: { width: cw, height: ch + 30, channels: 3, background: "#000" } }).composite([{ input: img, top: 30, left: 0 }, { input: cap(cw, t, 20), top: 0, left: 0 }]).png().toBuffer(); return sharp(c).resize(cellW, null).png().toBuffer(); };
    const row0 = await Promise.all(["A", "B", "C"].map((v) => full(compOf[v], `inv-mask · ${LABEL[v]}`)));
    const row1 = await Promise.all(["A", "B", "C"].map((v) => crop(compOf[v], `edge · ${LABEL[v]}`)));
    const h0 = (await sharp(row0[0]).metadata()).height, h1 = (await sharp(row1[0]).metadata()).height;
    const strip = (cells, top) => cells.map((pn, i) => ({ input: pn, left: i * (cellW + 6), top }));
    await sharp({ create: { width: (cellW + 6) * 3, height: h0 + h1 + 6, channels: 3, background: "#222" } })
      .composite([...strip(row0, 0), ...strip(row1, h0 + 6)])
      .jpeg({ quality: 92 }).toFile(join(DIR, `${sku}_inv_sheet.jpg`));
    console.log(`ok ${sku} → ${DIR}/${sku}_inv_sheet.jpg`);
  } catch (e) {
    console.log(`FAIL ${sku}: ${e.message}`);
  }
}
