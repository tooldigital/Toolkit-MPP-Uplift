// EXPERIMENT — dehalo hybrid with ONE Gemini call that does BOTH jobs explicitly: clean the fuzzy
// fur edge AND draw a soft grounding cast shadow. For flat products Photoroom can't ground (otter),
// this makes the shadow deterministic (requested), instead of relying on Gemini happening to keep one.
//
// Same hybrid math as exp_dehalo.mjs: real product interior + Gemini's clean edge in a wide border;
// the requested grey shadow rides through the ag-coverage step (grey ⇒ ag≈1 ⇒ kept) onto the ground.
// base = shadow.jpg is ignored where blank (sf≈1); the shadow is entirely Gemini's.
//
// Writes outputs/experiments/dehalo_shadow[_<BG>]/<sku>_{gemini,hybrid,mask,sbs}.jpg.
//   node --env-file=.env scripts/exp_dehalo_shadow.mjs PE936323 [sku..] [--bg F7F7F7] [--force]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BG = arg("--bg", "F7F7F7").replace(/^#/, "").toUpperCase();
const FORCE = process.argv.includes("--force");
const [bgR, bgG, bgB] = [parseInt(BG.slice(0, 2), 16), parseInt(BG.slice(2, 4), 16), parseInt(BG.slice(4, 6), 16)];
const skus = process.argv.slice(2).filter((a) => /^PE/i.test(a));
if (skus.length === 0) { console.error("usage: exp_dehalo_shadow.mjs <sku..> [--bg F7F7F7] [--force]"); process.exit(1); }

const W = 4000;
const OUT = `outputs/experiments/dehalo_shadow${BG === "FFFFFF" ? "" : "_" + BG}`;
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);

// ONE call, BOTH jobs stated explicitly.
const PROMPT = `This is a plush / soft-toy product photographed on a pure white background.

Do TWO things and nothing else:
1. CLEAN THE FUR EDGE. There is a thin bright white / light matting fringe all around the fuzzy fur silhouette. Recolor only those edge pixels to match the adjacent fur color, so the outline reads as soft, natural fur — not a hard cut. Reintroduce very fine, short, low-contrast fur strands right at the edge. Do NOT enlarge or move the silhouette.
2. ADD A CAST SHADOW. Draw ONE soft, neutral-grey cast shadow on the floor directly beneath the product, falling gently to the back-right. Every part of the product casts its shadow in this same consistent direction. The shadow is soft-edged and low-contrast.

- Keep the product body, its fur texture and color, pixel-for-pixel.
- Do NOT move, rescale, re-crop or recompose. Product stays in the EXACT same position and scale.
- The background stays pure flat white except for that one cast shadow.`;

for (const sku of skus) {
  process.stdout.write(`${sku} ... `);
  try {
    const dir = `outputs/work/${sku}`;
    const matteBytes = await readFile(join(dir, "matte.png"));
    const beforeBytes = await readFile(join(dir, `final_${BG}.jpg`));

    // Gemini: feed the product flattened on white (so the shadow is drawn on a clean plate).
    const gp = join(OUT, `${sku}_gemini.jpg`);
    let geminiBytes;
    if (!FORCE && await exists(gp)) geminiBytes = await readFile(gp);
    else {
      const onWhite = await sharp(matteBytes).resize(W, W).flatten({ background: "#fff" }).jpeg({ quality: 95 }).toBuffer();
      const raw = await generateShadowGemini({ apiKey: K, sku, image: onWhite, instruction: PROMPT, temperature: 0 });
      geminiBytes = await sharp(raw).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(gp, geminiBytes);
    }

    const before = await sharp(beforeBytes).resize(W, W).removeAlpha().raw().toBuffer();      // real product on BG (interior source)
    const gemini = await sharp(geminiBytes).resize(W, W).removeAlpha().raw().toBuffer();       // clean edge + grey shadow, on white
    const base   = await sharp(await readFile(join(dir, "shadow.jpg"))).resize(W, W).removeAlpha().raw().toBuffer();  // Photoroom (blank for otter)
    const A  = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const Ab = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").blur(18).raw().toBuffer();
    const N = W * W;

    // gemshadow: keep Gemini where non-white (fur AND the grey shadow), recolor pure-white ground to BG.
    const gemshadow = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const ag = 1 - smoothstep(238, 254, gray(gemini[i], gemini[i + 1], gemini[i + 2]));   // 1=product/shadow, 0=white
      const sf = (ag * 255 + (1 - ag) * gray(base[i], base[i + 1], base[i + 2])) / 255;
      gemshadow[i]     = clamp(gemini[i]     * ag + bgR * sf * (1 - ag));
      gemshadow[i + 1] = clamp(gemini[i + 1] * ag + bgG * sf * (1 - ag));
      gemshadow[i + 2] = clamp(gemini[i + 2] * ag + bgB * sf * (1 - ag));
    }

    // hybrid: real interior (before) + gemshadow in the wide silhouette border (rim + ground)
    const hybrid = Buffer.alloc(N * 3);
    const maskImg = Buffer.alloc(N);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const m = 1 - smoothstep(0.72, 0.97, Ab[p] / 255);
      maskImg[p] = clamp(m * 255);
      for (let c = 0; c < 3; c++) hybrid[i + c] = clamp(before[i + c] * (1 - m) + gemshadow[i + c] * m);
    }
    await sharp(hybrid, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toFile(join(OUT, `${sku}_hybrid.jpg`));
    await sharp(maskImg, { raw: { width: W, height: W, channels: 1 } }).jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_mask.jpg`));

    // sbs: raw Gemini | hybrid
    const g = await sharp(geminiBytes).resize(900, 900).png().toBuffer();
    const h = await sharp(hybrid, { raw: { width: W, height: W, channels: 3 } }).resize(900, 900).png().toBuffer();
    await sharp({ create: { width: 1808, height: 900, channels: 3, background: "#222" } })
      .composite([{ input: g, left: 0, top: 0 }, { input: h, left: 908, top: 0 }]).jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_sbs.jpg`));

    // QC: darkest ground (shadow present if <240)
    let mn = 255; for (let p = 0, i = 0; p < N; p++, i += 3) if (A[p] < 26) { const l = gray(hybrid[i], hybrid[i + 1], hybrid[i + 2]); if (l < mn) mn = l; }
    console.log(`ok  → ${OUT}/${sku}_hybrid.jpg  (darkest ground=${mn.toFixed(0)}, shadow if <240)`);
  } catch (e) {
    console.log("FAIL: " + e.message);
  }
}
