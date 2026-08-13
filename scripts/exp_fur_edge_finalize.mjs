// Finished grey plush finals: gem-on-F7F7F7 (contrast recovers pale fur) → band composite R=90 →
// relight-at-end → far-background lock to exact F7F7F7. All masks are matte-footprint based (NOT
// colour-distance) because the white paws ≈ the F7F7F7 bg and a colour mask would eat the paw fur.
//
//   node --env-file=.env scripts/exp_fur_edge_finalize.mjs PE317642 PE371748 PE936323 PE964848
//        [--bg F7F7F7] [--R 90] [--strength 0.08]

import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BG = arg("--bg", "F7F7F7").replace(/^#/, "").toUpperCase();
const R = parseInt(arg("--R", "90"), 10);
const STRENGTH = parseFloat(arg("--strength", "0.08"));
const skus = process.argv.slice(2).filter((a) => /^PE/i.test(a));
if (skus.length === 0) { console.error("usage: exp_fur_edge_finalize.mjs <sku..>"); process.exit(1); }

const W = 4000;
const GEMDIR = "outputs/experiments/fur_edge";
const OUTDIR = `outputs/finals_plush_furedge_${BG.toLowerCase()}/group_plush`;
await mkdir(OUTDIR, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);
const [BR, BGc, BB] = [parseInt(BG.slice(0, 2), 16), parseInt(BG.slice(2, 4), 16), parseInt(BG.slice(4, 6), 16)];
const prompt = `This is a plush toy photographed on a solid grey #${BG} background.

Clean the fuzzy silhouette edge all around: remove any pale/white matting fringe, and reintroduce very fine, short, low-contrast fur strands right at the edge (especially on any light/white fur) so the whole outline reads as soft natural fur — NOT a hard cut.
- Keep the product body, its fur texture and color, pixel-for-pixel. Do NOT enlarge or extend the overall shape.
- Keep the background a solid, even grey of the SAME colour #${BG}.
- Do NOT move, rescale, re-crop or recompose.`;

const report = [];
for (const sku of skus) {
  try {
    const dir = `outputs/work/${sku}`;
    const matte = await readFile(join(dir, "matte.png"));
    const relit = await readFile(join(dir, "relit.jpg"));

    // gem on the grey bg (contrast) — reuse cached greytest gem, else generate
    const gp = join(GEMDIR, `${sku}_gemgrey_${BG}.jpg`);
    let gemBytes;
    if (await exists(gp)) gemBytes = await readFile(gp);
    else {
      const onGrey = await sharp(matte).resize(W, W).flatten({ background: { r: BR, g: BGc, b: BB } }).jpeg({ quality: 95 }).toBuffer();
      process.stdout.write(`${sku}: gemini on #${BG} ...`);
      const raw = await generateShadowGemini({ apiKey: K, sku, image: onGrey, instruction: prompt, temperature: 0 });
      gemBytes = await sharp(raw).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(gp, gemBytes);
      process.stdout.write(" ok\n");
    }

    const subj = await sharp(matte).resize(W, W).removeAlpha().raw().toBuffer();
    const gem  = await sharp(gemBytes).resize(W, W).removeAlpha().raw().toBuffer();
    const a    = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const AbR  = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(R).raw().toBuffer();     // band selector
    const Ab15 = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(15).raw().toBuffer();    // relight footprint
    const Ab80 = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(80).raw().toBuffer();    // far-bg lock
    const gmap = await sharp(relit).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
    const N = W * W;
    const lm = new Float32Array(N);
    for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(gmap[k], gmap[k + 1], gmap[k + 2]);
    let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const av = a[p] / 255; gs += lm[p] * av; aw += av; }
    const mean = aw > 0 ? gs / aw : 128;

    const out = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const I = smoothstep(0.55, 0.92, AbR[p] / 255);           // 1 deep interior, 0 across band+outside
      const pw = (a[p] / 255) * I;                              // real product only deep inside
      const rl = 1 + ((lm[p] - mean) / 128) * STRENGTH * smoothstep(0.02, 0.20, Ab15[p] / 255);  // relight body+edge
      const lock = 1 - smoothstep(0.004, 0.05, Ab80[p] / 255);  // 1 = far background → snap to exact BG
      out[i]     = clamp((subj[i]     * pw + gem[i]     * (1 - pw)) * rl * (1 - lock) + BR  * lock);
      out[i + 1] = clamp((subj[i + 1] * pw + gem[i + 1] * (1 - pw)) * rl * (1 - lock) + BGc * lock);
      out[i + 2] = clamp((subj[i + 2] * pw + gem[i + 2] * (1 - pw)) * rl * (1 - lock) + BB  * lock);
    }
    const buf = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    await writeFile(join(OUTDIR, `${sku}.jpg`), buf);

    // QC: sample the four far corners
    const corner = async (left, top) => {
      const rgba = await sharp(buf).extract({ left, top, width: 200, height: 200 }).raw().toBuffer();
      let sr = 0, sg = 0, sb = 0; const n = rgba.length / 3;
      for (let j = 0; j < rgba.length; j += 3) { sr += rgba[j]; sg += rgba[j + 1]; sb += rgba[j + 2]; }
      return [sr / n, sg / n, sb / n];
    };
    const cs = [await corner(20, 20), await corner(W - 220, 20), await corner(20, W - 220), await corner(W - 220, W - 220)];
    const dev = Math.max(...cs.flatMap(([r, g, b]) => [Math.abs(r - BR), Math.abs(g - BGc), Math.abs(b - BB)]));
    report.push({ sku, mean: mean.toFixed(1), cornerMaxΔ: dev.toFixed(2) });
    console.log(`ok ${sku} → ${OUTDIR}/${sku}.jpg  (relightMean=${mean.toFixed(1)}, cornerMaxΔfromBG=${dev.toFixed(2)})`);
  } catch (e) {
    console.log(`FAIL ${sku}: ${e.message}`);
  }
}

// contact sheet
const cells = [];
for (const sku of skus) {
  const p = join(OUTDIR, `${sku}.jpg`);
  if (!(await exists(p))) continue;
  const img = await sharp(p).resize(560, 560, { fit: "contain", background: `#${BG}` }).toBuffer();
  const cap = Buffer.from(`<svg width="560" height="26"><rect width="100%" height="100%" fill="black"/><text x="8" y="19" font-family="monospace" font-size="16" fill="white">${sku}</text></svg>`);
  cells.push(await sharp(img).composite([{ input: cap, top: 0, left: 0 }]).png().toBuffer());
}
const cols = 2, cw = 560, rows = Math.ceil(cells.length / cols);
await sharp({ create: { width: cols * (cw + 8), height: rows * (cw + 8), channels: 3, background: "#222" } })
  .composite(cells.map((c, i) => ({ input: c, left: (i % cols) * (cw + 8), top: Math.floor(i / cols) * (cw + 8) })))
  .jpeg({ quality: 92 }).toFile(`outputs/contact_sheet_plush_furedge_${BG.toLowerCase()}.jpg`);
console.log(`\nQC corners (max Δ from #${BG}):`); for (const r of report) console.log(`  ${r.sku}: Δ=${r.cornerMaxΔ}`);
console.log(`contact sheet → outputs/contact_sheet_plush_furedge_${BG.toLowerCase()}.jpg`);
