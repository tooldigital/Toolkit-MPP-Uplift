// Finished WHITE plush finals from the band experiment (no grey, no glow):
//   gem = Gemini clean on WHITE (gem_B) → band composite R=90 → relight at the very end →
//   gentle far-background lock to pure white.
// All masks are matte-footprint based. No Gemini calls (gem_B + matte + relit are cached).
//
//   node scripts/exp_fur_edge_finalize_white.mjs PE317642 PE371748 PE936323 PE964848 [--R 90] [--strength 0.08] [--gem B]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const R = parseInt(arg("--R", "90"), 10);
const STRENGTH = parseFloat(arg("--strength", "0.08"));
const GEM = arg("--gem", "B").toUpperCase();
const skus = process.argv.slice(2).filter((a) => /^PE/i.test(a));
if (skus.length === 0) { console.error("usage: exp_fur_edge_finalize_white.mjs <sku..>"); process.exit(1); }

const W = 4000;
const GEMDIR = "outputs/experiments/fur_edge";
const OUTDIR = "outputs/finals_plush_furedge_white/group_plush";
await mkdir(OUTDIR, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);

const report = [];
for (const sku of skus) {
  try {
    const dir = `outputs/work/${sku}`;
    const matte = await readFile(join(dir, "matte.png"));
    const relit = await readFile(join(dir, "relit.jpg"));
    const gem   = await sharp(join(GEMDIR, `${sku}_gem_${GEM}.jpg`)).resize(W, W).removeAlpha().raw().toBuffer();  // Gemini on WHITE

    const subj = await sharp(matte).resize(W, W).removeAlpha().raw().toBuffer();
    const a    = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const AbR  = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(R).raw().toBuffer();
    const Ab15 = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(15).raw().toBuffer();
    const Ab80 = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(80).raw().toBuffer();
    const gmap = await sharp(relit).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
    const N = W * W;
    const lm = new Float32Array(N);
    for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(gmap[k], gmap[k + 1], gmap[k + 2]);
    let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const av = a[p] / 255; gs += lm[p] * av; aw += av; }
    const mean = aw > 0 ? gs / aw : 128;

    const out = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const I = smoothstep(0.55, 0.92, AbR[p] / 255);
      const pw = (a[p] / 255) * I;
      const rl = 1 + ((lm[p] - mean) / 128) * STRENGTH * smoothstep(0.02, 0.20, Ab15[p] / 255);
      const lock = 1 - smoothstep(0.004, 0.05, Ab80[p] / 255);  // far bg → pure white
      for (let c = 0; c < 3; c++) out[i + c] = clamp((subj[i + c] * pw + gem[i + c] * (1 - pw)) * rl * (1 - lock) + 255 * lock);
    }
    const buf = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    await writeFile(join(OUTDIR, `${sku}.jpg`), buf);

    const corner = async (left, top) => { const r = await sharp(buf).extract({ left, top, width: 200, height: 200 }).raw().toBuffer(); let s = 0; for (let j = 0; j < r.length; j++) s += r[j]; return s / r.length; };
    const cmin = Math.min(await corner(20, 20), await corner(W - 220, 20), await corner(20, W - 220), await corner(W - 220, W - 220));
    report.push({ sku, mean: mean.toFixed(1), cornerMin: cmin.toFixed(1) });
    console.log(`ok ${sku} → ${OUTDIR}/${sku}.jpg  (relightMean=${mean.toFixed(1)}, darkestCornerMean=${cmin.toFixed(1)})`);
  } catch (e) {
    console.log(`FAIL ${sku}: ${e.message}`);
  }
}

const cells = [];
for (const sku of skus) {
  const p = join(OUTDIR, `${sku}.jpg`);
  if (!(await exists(p))) continue;
  const img = await sharp(p).resize(560, 560, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).toBuffer();
  const cap = Buffer.from(`<svg width="560" height="26"><rect width="100%" height="100%" fill="black"/><text x="8" y="19" font-family="monospace" font-size="16" fill="white">${sku}</text></svg>`);
  cells.push(await sharp(img).composite([{ input: cap, top: 0, left: 0 }]).png().toBuffer());
}
const cols = 2, cw = 560, rows = Math.ceil(cells.length / cols);
await sharp({ create: { width: cols * (cw + 8), height: rows * (cw + 8), channels: 3, background: "#ddd" } })
  .composite(cells.map((c, i) => ({ input: c, left: (i % cols) * (cw + 8), top: Math.floor(i / cols) * (cw + 8) })))
  .jpeg({ quality: 92 }).toFile("outputs/contact_sheet_plush_furedge_white.jpg");
console.log("\ncontact sheet → outputs/contact_sheet_plush_furedge_white.jpg");
