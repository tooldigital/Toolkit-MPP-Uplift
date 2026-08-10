// EXPERIMENT — the NORMAL pipeline composite but with Photoroom HD background removal for the matte
// (header pr-hd-background-removal: auto, Plus plan → crisper subject edges ≥2K). Same plate + same
// opaque composite as run_pipeline (subj·relight·a + BG·sf·(1-a)), reusing the cached Photoroom
// shadow + Gemini relight, so ONLY the matte differs from the standard NORMAL baseline.
// Writes outputs/experiments/hd_removal/<sku>_normalhd.jpg and caches the HD matte at
// outputs/work/<sku>/matte_hd.png.
//
//   node --env-file=.env scripts/exp_hd_removal.mjs [PE317642 ...] [--bg F7F7F7] [--strength 0.08] [--force]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { makePlate, composeBackground } from "../src/plate.mjs";
import { cutout } from "../src/cutout.mjs";

const K = process.env.PHOTOROOM_KEY;
if (!K) { console.error("Set PHOTOROOM_KEY"); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BG = arg("--bg", "F7F7F7").replace(/^#/, "").toUpperCase();
const STRENGTH = parseFloat(arg("--strength", "0.08"));
const FORCE = process.argv.includes("--force");
const skus = process.argv.slice(2).filter((a) => /^PE/i.test(a));
if (skus.length === 0) skus.push("PE317642", "PE371748", "PE964848", "PE936323");

const W = 4000, SRC = "inputs/group_plush";
const OUT = "outputs/experiments/hd_removal";
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const [bgR, bgG, bgB] = [parseInt(BG.slice(0, 2), 16), parseInt(BG.slice(2, 4), 16), parseInt(BG.slice(4, 6), 16)];
const exists = (p) => readFile(p).then(() => true, () => false);

for (const sku of skus) {
  process.stdout.write(`${sku} ... `);
  try {
    const dir = `outputs/work/${sku}`;
    // 1. Same plate as the pipeline (makePlate → white canvas), then HD cutout. Cached at matte_hd.png.
    const hdp = join(dir, "matte_hd.png");
    let matteBytes;
    if (!FORCE && await exists(hdp)) matteBytes = await readFile(hdp);
    else {
      const { plate } = await makePlate({ source: join(SRC, `${sku}.jpg`) });
      const plateWhite = await composeBackground(plate, "FFFFFF");
      matteBytes = await cutout({ apiKey: K, sku, image: plateWhite, filename: `${sku}.png`, outputSize: "4000x4000", padding: 0.10, hd: true });
      await writeFile(hdp, Buffer.from(matteBytes));
      process.stdout.write("HD matte ok ... ");
    }

    // 2. Standard opaque composite (identical to run_pipeline), reusing cached shadow + relit.
    const subj = await sharp(matteBytes).resize(W, W).removeAlpha().raw().toBuffer();
    const sAlpha = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const base = await sharp(await readFile(join(dir, "shadow.jpg"))).resize(W, W).removeAlpha().raw().toBuffer();
    const g = await sharp(await readFile(join(dir, "relit.jpg"))).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
    const N = W * W, lm = new Float32Array(N);
    for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(g[k], g[k + 1], g[k + 2]);
    let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const a = sAlpha[p] / 255; gs += lm[p] * a; aw += a; }
    const mean = aw > 0 ? gs / aw : 128;
    const out = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const a = sAlpha[p] / 255;
      const f = 1 + ((lm[p] - mean) / 128) * STRENGTH;
      const sf = (a * 255 + (1 - a) * gray(base[i], base[i + 1], base[i + 2])) / 255;
      out[i] = clamp(subj[i] * f * a + bgR * sf * (1 - a));
      out[i + 1] = clamp(subj[i + 1] * f * a + bgG * sf * (1 - a));
      out[i + 2] = clamp(subj[i + 2] * f * a + bgB * sf * (1 - a));
    }
    await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toFile(join(OUT, `${sku}_normalhd.jpg`));
    console.log(`ok (relightMean=${mean.toFixed(1)})`);
  } catch (e) { console.log("FAIL: " + e.message); }
}
