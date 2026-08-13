// Plush final on F7F7F7 with the GEMINI shadow, no halo. Product/background are split at the TRUE
// silhouette via a flood-fill of the exterior (from the image border) — NOT a blurred alpha, which
// lags the edge and leaves the bright ring (the halo). Interior crevices are enclosed, so flood-fill
// never reaches them: they stay product (gem cream), no band. Background = F7F7F7 darkened by the
// Gemini-harvested shadow. Relight at the end.
//
//   product = subj*a + gem*(1-a)                    (crevices/edges from gem, like the inv comp)
//   ext     = floodFill(alpha<thr from border)      (true exterior only; crevices excluded)
//   sf      = luma(blur(harvestShadow,16))/255       (Gemini shadow factor)
//   out     = product*relight*(1-ext) + (F7F7F7*sf)*ext
//
//   node --env-file=.env scripts/exp_fur_edge_f7_gemshadow.mjs PE936323 [sku..] [--bg F7F7F7] [--gem B] [--strength 0.08]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { harvestShadow } from "../src/shadow-patch.mjs";

const K = process.env.GEMINI_KEY;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BG = arg("--bg", "F7F7F7").replace(/^#/, "").toUpperCase();
const GEM = arg("--gem", "B").toUpperCase();
const STRENGTH = parseFloat(arg("--strength", "0.08"));
const skus = process.argv.slice(2).filter((a) => /^PE/i.test(a));
if (skus.length === 0) { console.error("usage: exp_fur_edge_f7_gemshadow.mjs <sku..>"); process.exit(1); }

const W = 4000, FS = 1000;   // FS = flood-fill working size
const GEMDIR = "outputs/experiments/fur_edge";
const OUTDIR = `outputs/finals_plush_f7_gemshadow/group_plush`;
await mkdir(OUTDIR, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);
const [BR, BGc, BB] = [parseInt(BG.slice(0, 2), 16), parseInt(BG.slice(2, 4), 16), parseInt(BG.slice(4, 6), 16)];

// flood-fill exterior background from the border, over pixels with alpha < thr. Returns Uint8 (255=exterior).
function floodExterior(alpha, w, h, thr = 30) {
  const ext = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => { const i = y * w + x; if (!ext[i] && alpha[i] < thr) { ext[i] = 255; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  return ext;
}

for (const sku of skus) {
  try {
    const dir = `outputs/work/${sku}`;
    const matte = await readFile(join(dir, "matte.png"));
    const relit = await readFile(join(dir, "relit.jpg"));
    const subj = await sharp(matte).resize(W, W).removeAlpha().raw().toBuffer();
    const gem  = await sharp(join(GEMDIR, `${sku}_gem_${GEM}.jpg`)).resize(W, W).removeAlpha().raw().toBuffer();
    const a    = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const Ab15 = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(15).raw().toBuffer();

    // shadow base: Photoroom if present, else Gemini harvest (cached)
    const prBase = await sharp(join(dir, "shadow.jpg")).resize(W, W).removeAlpha().raw().toBuffer();
    let gmin = 255; for (let p = 0, i = 0; p < W * W; p++, i += 3) if (a[p] < 26) { const l = gray(prBase[i], prBase[i + 1], prBase[i + 2]); if (l < gmin) gmin = l; }
    let shadowBytes;
    if (gmin > 240) {
      const hp = join(dir, "shadow_harvest.jpg");
      if (await exists(hp)) shadowBytes = await readFile(hp);
      else { if (!K) throw new Error("blank PR shadow, no cached harvest; set GEMINI_KEY");
        process.stdout.write(`${sku}: PR shadow blank → harvest ...`);
        const { withShadow } = await harvestShadow({ apiKey: K, matteBytes: matte, size: W });
        shadowBytes = await sharp(withShadow, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
        await writeFile(hp, shadowBytes); process.stdout.write(" ok\n"); }
    } else shadowBytes = await readFile(join(dir, "shadow.jpg"));
    const sb = await sharp(shadowBytes).resize(W, W).blur(16).removeAlpha().raw().toBuffer();

    // exterior mask via flood-fill at FS, upscaled + feathered
    const aSmall = await sharp(matte).resize(FS, FS).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const extSmall = floodExterior(aSmall, FS, FS, 30);
    const ext = await sharp(Buffer.from(extSmall), { raw: { width: FS, height: FS, channels: 1 } })
      .resize(W, W).blur(6).raw().toBuffer();

    // relight map
    const gmap = await sharp(relit).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
    const N = W * W; const lm = new Float32Array(N);
    for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(gmap[k], gmap[k + 1], gmap[k + 2]);
    let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const av = a[p] / 255; gs += lm[p] * av; aw += av; }
    const mean = aw > 0 ? gs / aw : 128;

    const out = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const av = a[p] / 255;
      const e = ext[p] / 255;                                   // 1 = true exterior background
      const sf = Math.min(1, gray(sb[i], sb[i + 1], sb[i + 2]) / 255);
      const rl = 1 + ((lm[p] - mean) / 128) * STRENGTH * smoothstep(0.02, 0.20, Ab15[p] / 255);
      out[i]     = clamp((subj[i]     * av + gem[i]     * (1 - av)) * rl * (1 - e) + (BR  * sf) * e);
      out[i + 1] = clamp((subj[i + 1] * av + gem[i + 1] * (1 - av)) * rl * (1 - e) + (BGc * sf) * e);
      out[i + 2] = clamp((subj[i + 2] * av + gem[i + 2] * (1 - av)) * rl * (1 - e) + (BB  * sf) * e);
    }
    const buf = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    await writeFile(join(OUTDIR, `${sku}.jpg`), buf);
    console.log(`ok ${sku} → ${OUTDIR}/${sku}.jpg  (bg=${BG}, PRblank=${gmin > 240}, relightMean=${mean.toFixed(1)})`);
  } catch (e) {
    console.log(`FAIL ${sku}: ${e.message}`);
  }
}
