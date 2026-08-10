// EXPERIMENT — two Gemini roles merged: FUR from the strand-rich de-halo output (gem_B) in a WIDE
// band, SHADOW from the Gemini shadow render, on the robust dehalo hybrid structure (real interior →
// no crevice band). For flat products with no Photoroom shadow (otter). On F7F7F7.
//
//   gemshadow = gemFur·ag + (BG·sf)·(1-ag)           ag = non-white(gemFur): fur/crevice ⇒ keep gemFur
//                                                    sf = shadow factor from the Gemini shadow render
//   hybrid    = before·(1-m) + gemshadow·m           m = wide border (blur R=90) pulls fur in;
//                                                    interior stays the REAL product (before)
//   out       = hybrid · relight
//
// Roles: gemFur = fur_edge/<sku>_gem_B.jpg (strands, on white, NO shadow).
//        shadowSrc = work/<sku>/shadow_harvest.jpg (Gemini cast shadow) — harvested if missing.
//
//   node --env-file=.env scripts/exp_dehalo_furshadow.mjs PE936323 [sku..] [--bg F7F7F7] [--R 90] [--strength 0.08]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { harvestShadow } from "../src/shadow-patch.mjs";

const K = process.env.GEMINI_KEY;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BG = arg("--bg", "F7F7F7").replace(/^#/, "").toUpperCase();
const R = parseInt(arg("--R", "90"), 10);
const FULL = process.argv.includes("--full");   // band all the way: gem_B fur over the WHOLE product (no interior seam)
const STRENGTH = parseFloat(arg("--strength", "0.08"));
const GEM = arg("--gem", "B").toUpperCase();
const [bgR, bgG, bgB] = [parseInt(BG.slice(0, 2), 16), parseInt(BG.slice(2, 4), 16), parseInt(BG.slice(4, 6), 16)];
const skus = process.argv.slice(2).filter((a) => /^PE/i.test(a));
if (skus.length === 0) { console.error("usage: exp_dehalo_furshadow.mjs <sku..> [--bg F7F7F7] [--R 90]"); process.exit(1); }

const W = 4000;
const OUT = `outputs/experiments/dehalo_furshadow${BG === "FFFFFF" ? "" : "_" + BG}`;
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);

for (const sku of skus) {
  process.stdout.write(`${sku} ... `);
  try {
    const dir = `outputs/work/${sku}`;
    const matteBytes = await readFile(join(dir, "matte.png"));
    const before = await sharp(await readFile(join(dir, `final_${BG}.jpg`))).resize(W, W).removeAlpha().raw().toBuffer();  // real product on BG
    const gemFur = await sharp(await readFile(join("outputs/experiments/fur_edge", `${sku}_gem_${GEM}.jpg`))).resize(W, W).removeAlpha().raw().toBuffer(); // strands, on white
    const relitBytes = await readFile(join(dir, "relit.jpg"));

    // Gemini shadow render (harvest if not cached)
    const hp = join(dir, "shadow_harvest.jpg");
    let shadowBytes;
    if (await exists(hp)) shadowBytes = await readFile(hp);
    else { if (!K) throw new Error("no cached harvest; set GEMINI_KEY");
      const { withShadow } = await harvestShadow({ apiKey: K, matteBytes, size: W });
      shadowBytes = await sharp(withShadow, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(hp, shadowBytes); }
    const base = await sharp(shadowBytes).resize(W, W).removeAlpha().raw().toBuffer();

    const A  = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const Ab = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").blur(R).raw().toBuffer();
    const Ab15 = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").blur(15).raw().toBuffer();
    const gmap = await sharp(relitBytes).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
    const N = W * W;
    const lm = new Float32Array(N);
    for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(gmap[k], gmap[k + 1], gmap[k + 2]);
    let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const av = A[p] / 255; gs += lm[p] * av; aw += av; }
    const mean = aw > 0 ? gs / aw : 128;

    const out = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const ag = 1 - smoothstep(238, 254, gray(gemFur[i], gemFur[i + 1], gemFur[i + 2]));  // fur/crevice ⇒ 1, white ⇒ 0
      const sf = (ag * 255 + (1 - ag) * gray(base[i], base[i + 1], base[i + 2])) / 255;     // Gemini shadow on ground
      const m = FULL ? 1 : 1 - smoothstep(0.72, 0.97, Ab[p] / 255);                         // FULL: gem_B everywhere (no seam)
      const rl = 1 + ((lm[p] - mean) / 128) * STRENGTH * smoothstep(0.02, 0.20, Ab15[p] / 255);
      const gsC = [bgR, bgG, bgB];
      for (let c = 0; c < 3; c++) {
        const gemshadow = gemFur[i + c] * ag + gsC[c] * sf * (1 - ag);   // fur (gem_B) OR BG·shadow
        out[i + c] = clamp((before[i + c] * (1 - m) + gemshadow * m) * rl);
      }
    }
    const buf = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    await writeFile(join(OUT, `${sku}.jpg`), buf);

    let mn = 255; for (let p = 0, i = 0; p < N; p++, i += 3) if (A[p] < 26) { const l = gray(out[i], out[i + 1], out[i + 2]); if (l < mn) mn = l; }
    console.log(`ok → ${OUT}/${sku}.jpg  (darkest ground=${mn.toFixed(0)}, relightMean=${mean.toFixed(1)})`);
  } catch (e) {
    console.log("FAIL: " + e.message);
  }
}
