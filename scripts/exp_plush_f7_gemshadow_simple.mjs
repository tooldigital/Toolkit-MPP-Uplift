// Plush final on F7F7F7 with the Gemini shadow — the STANDARD pipeline composite (no fancy masks,
// which is what kept introducing halos). Identical math to run_pipeline.mjs opaque path:
//     out = subj * relight * a  +  (BG * sf) * (1 - a)
// with sf = the Gemini-harvested shadow factor (used because Photoroom's shadow is blank here).
// a = matte alpha, so the product/background split is the crisp matte edge — no ring, no lag.
//
//   node --env-file=.env scripts/exp_plush_f7_gemshadow_simple.mjs PE936323 [sku..] [--bg F7F7F7] [--strength 0.08]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { harvestShadow } from "../src/shadow-patch.mjs";

const K = process.env.GEMINI_KEY;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BG = arg("--bg", "F7F7F7").replace(/^#/, "").toUpperCase();
const STRENGTH = parseFloat(arg("--strength", "0.08"));
const skus = process.argv.slice(2).filter((a) => /^PE/i.test(a));
if (skus.length === 0) { console.error("usage: <sku..>"); process.exit(1); }

const W = 4000;
const OUTDIR = "outputs/finals_plush_f7_gemshadow/group_plush";
await mkdir(OUTDIR, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const exists = (p) => readFile(p).then(() => true, () => false);
const [BR, BGc, BB] = [parseInt(BG.slice(0, 2), 16), parseInt(BG.slice(2, 4), 16), parseInt(BG.slice(4, 6), 16)];

for (const sku of skus) {
  try {
    const dir = `outputs/work/${sku}`;
    const matte = await readFile(join(dir, "matte.png"));
    const relit = await readFile(join(dir, "relit.jpg"));
    const subj = await sharp(matte).resize(W, W).removeAlpha().raw().toBuffer();
    const a    = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();

    // shadow factor sf: Photoroom if present, else Gemini harvest (cached)
    const prBase = await sharp(join(dir, "shadow.jpg")).resize(W, W).removeAlpha().raw().toBuffer();
    let gmin = 255; for (let p = 0, i = 0; p < W * W; p++, i += 3) if (a[p] < 26) { const l = gray(prBase[i], prBase[i + 1], prBase[i + 2]); if (l < gmin) gmin = l; }
    let shadowBytes;
    if (gmin > 240) {
      const hp = join(dir, "shadow_harvest.jpg");
      if (await exists(hp)) shadowBytes = await readFile(hp);
      else { if (!K) throw new Error("blank PR shadow, no cached harvest; set GEMINI_KEY");
        process.stdout.write(`${sku}: harvest ...`); const { withShadow } = await harvestShadow({ apiKey: K, matteBytes: matte, size: W });
        shadowBytes = await sharp(withShadow, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
        await writeFile(hp, shadowBytes); process.stdout.write(" ok\n"); }
    } else shadowBytes = await readFile(join(dir, "shadow.jpg"));
    const sb = await sharp(shadowBytes).resize(W, W).blur(20).removeAlpha().raw().toBuffer();   // low-pass shadow

    // relight lightmap (mean-normalized, product-weighted) — same as pipeline
    const gmap = await sharp(relit).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
    const N = W * W; const lm = new Float32Array(N);
    for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(gmap[k], gmap[k + 1], gmap[k + 2]);
    let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const av = a[p] / 255; gs += lm[p] * av; aw += av; }
    const mean = aw > 0 ? gs / aw : 128;

    const out = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const av = a[p] / 255;
      const f = 1 + ((lm[p] - mean) / 128) * STRENGTH;              // gentle relight on product
      const sf = Math.min(1, gray(sb[i], sb[i + 1], sb[i + 2]) / 255);
      out[i]     = clamp(subj[i]     * f * av + (BR  * sf) * (1 - av));
      out[i + 1] = clamp(subj[i + 1] * f * av + (BGc * sf) * (1 - av));
      out[i + 2] = clamp(subj[i + 2] * f * av + (BB  * sf) * (1 - av));
    }
    const buf = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    await writeFile(join(OUTDIR, `${sku}.jpg`), buf);
    console.log(`ok ${sku} → ${OUTDIR}/${sku}.jpg  (bg=${BG}, PRblank=${gmin > 240}, relightMean=${mean.toFixed(1)})`);
  } catch (e) { console.log(`FAIL ${sku}: ${e.message}`); }
}
