// Shadowless-product finals via the INV composite (no fur band, no non-white keying — that keyed the
// cream belly as bg and bled a white band). Product = subj*a + gem*(1-a); then GROUND it on the
// Gemini-harvested shadow (for products whose Photoroom shadow is blank) by darkening only the true
// EXTERIOR background with the shadow factor. Relight at the end.
//
//   inv  = subj*a + gem*(1-a)                              (clean product incl. crevices, from gem)
//   ext  = 1 - smoothstep(0.004,0.05, blur(a,80))          (true exterior bg only; interior protected)
//   sf   = luma(blur(shadowBase,16))/255                   (shadow factor; Gemini harvest if PR blank)
//   out  = inv * (1 - ext*(1-sf)) * relight
//
//   node --env-file=.env scripts/exp_fur_edge_finalize_inv.mjs PE936323 [sku..] [--strength 0.08] [--gem B]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { harvestShadow } from "../src/shadow-patch.mjs";

const K = process.env.GEMINI_KEY;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const STRENGTH = parseFloat(arg("--strength", "0.08"));
const GEM = arg("--gem", "B").toUpperCase();
const skus = process.argv.slice(2).filter((a) => /^PE/i.test(a));
if (skus.length === 0) { console.error("usage: exp_fur_edge_finalize_inv.mjs <sku..>"); process.exit(1); }

const W = 4000;
const GEMDIR = "outputs/experiments/fur_edge";
const OUTDIR = "outputs/finals_plush_furedge_inv/group_plush";
await mkdir(OUTDIR, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);

for (const sku of skus) {
  try {
    const dir = `outputs/work/${sku}`;
    const matte = await readFile(join(dir, "matte.png"));
    const relit = await readFile(join(dir, "relit.jpg"));
    const subj = await sharp(matte).resize(W, W).removeAlpha().raw().toBuffer();
    const gem  = await sharp(join(GEMDIR, `${sku}_gem_${GEM}.jpg`)).resize(W, W).removeAlpha().raw().toBuffer();
    const a    = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const Ab80 = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(80).raw().toBuffer();
    const Ab15 = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(15).raw().toBuffer();

    // shadow base: Photoroom if it has one, else Gemini harvest (cached)
    const prBase = await sharp(join(dir, "shadow.jpg")).resize(W, W).removeAlpha().raw().toBuffer();
    let groundMin = 255; for (let p = 0, i = 0; p < W * W; p++, i += 3) if (a[p] < 26) { const l = gray(prBase[i], prBase[i + 1], prBase[i + 2]); if (l < groundMin) groundMin = l; }
    let shadowBaseBytes;
    if (groundMin > 240) {
      const hp = join(dir, "shadow_harvest.jpg");
      if (await exists(hp)) shadowBaseBytes = await readFile(hp);
      else {
        if (!K) throw new Error("blank Photoroom shadow and no cached harvest; set GEMINI_KEY");
        process.stdout.write(`${sku}: PR shadow blank → harvesting Gemini shadow ...`);
        const { withShadow } = await harvestShadow({ apiKey: K, matteBytes: matte, size: W });
        shadowBaseBytes = await sharp(withShadow, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
        await writeFile(hp, shadowBaseBytes); process.stdout.write(" ok\n");
      }
    } else shadowBaseBytes = await readFile(join(dir, "shadow.jpg"));
    const sb = await sharp(shadowBaseBytes).resize(W, W).blur(16).removeAlpha().raw().toBuffer();   // low-pass shadow

    // relight map
    const gmap = await sharp(relit).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
    const N = W * W;
    const lm = new Float32Array(N);
    for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(gmap[k], gmap[k + 1], gmap[k + 2]);
    let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const av = a[p] / 255; gs += lm[p] * av; aw += av; }
    const mean = aw > 0 ? gs / aw : 128;

    const out = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const av = a[p] / 255;
      const ext = 1 - smoothstep(0.004, 0.05, Ab80[p] / 255);            // true exterior bg
      const sf = Math.min(1, gray(sb[i], sb[i + 1], sb[i + 2]) / 255);   // shadow factor
      const ground = 1 - ext * (1 - sf);                                 // darken only exterior
      const rl = 1 + ((lm[p] - mean) / 128) * STRENGTH * smoothstep(0.02, 0.20, Ab15[p] / 255);
      for (let c = 0; c < 3; c++) {
        const inv = subj[i + c] * av + gem[i + c] * (1 - av);            // clean product (crevices from gem)
        out[i + c] = clamp(inv * ground * rl);
      }
    }
    const buf = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    await writeFile(join(OUTDIR, `${sku}.jpg`), buf);
    console.log(`ok ${sku} → ${OUTDIR}/${sku}.jpg  (relightMean=${mean.toFixed(1)}, PRblank=${groundMin > 240})`);
  } catch (e) {
    console.log(`FAIL ${sku}: ${e.message}`);
  }
}
