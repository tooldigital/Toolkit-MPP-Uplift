// EXPERIMENT — remove the white matting fringe ("halo") around fuzzy/fur silhouettes.
// Separate from the production pipeline; writes ONLY to outputs/experiments/dehalo/.
//
// The halo is intrinsic to opaque matte compositing of fur: removeBackground keeps the
// ORIGINAL photo pixels, and a fur edge's pixels are fur mixed with the white studio bg.
// The composite subj*a + bg*(1-a) on white then leaves a bright rim. Gemini can repaint that
// rim to fur color; this experiment blends its output back ONLY in a thin silhouette band,
// darken-only (Gemini can only pull the rim down toward fur — never brighten or repaint the
// body), so it's robust to Gemini's slight reframe and never touches the product interior.
//
// The bright rim only shows where the background behind it is dark — i.e. the BOTTOM contact,
// where the fur meets the GRAY cast shadow (on white it's invisible). It's matte alpha that's a
// touch too generous: a ring of near-white background pixels kept as partial foreground.
//
// Gemini removes the rim beautifully but (a) deletes the cast shadow and (b) redraws the whole
// product (face eyes/muzzle shift, blue cast). It does NOT reframe though — bbox drift ~1 px. So:
//   1. gemshadow — take Gemini's de-halo'd product, drop OUR shadow back onto the ground.
//   2. hybrid    — use gemshadow only in a WIDE border (rim + inward margin) and keep the REAL
//                  product in the deep interior; the crossover sits in solid fur, so the face
//                  stays pixel-real, the rim is gone, and the shadow is preserved. RECOMMENDED.
//
// Reads the cached final_FFFFFF.jpg + matte.png + shadow.jpg from outputs/work/<sku>/. Writes:
//   <sku>_hybrid.jpg    — THE FIX: Gemini clean edge + real interior + our shadow   ← recommended
//   <sku>_gemshadow.jpg — Gemini product over our shadow (rim gone, but face redrawn)
//   <sku>_gemini.jpg    — RAW Gemini "remove white fringe" output (upscaled to 4000²)  ← saved
//   <sku>_mask.jpg      — the wide-border mask (white = take gemshadow, black = keep real)
//   <sku>_sbs.jpg       — bottom-edge zoom: before | gemshadow | hybrid
//
//   node --env-file=.env scripts/exp_dehalo.mjs PE964848 [sku...] [--strength 1.0]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const STRENGTH = parseFloat(arg("--strength", "1.0"));   // scales the band mask (blend amount)
const RELIGHT = parseFloat(arg("--relight", "0"));       // gentle relight on the PRODUCT only (0 = off; 0.08 matches the plush set)
const NOSTRANDS = process.argv.includes("--nostrands");  // "no fur" variant: recolor the rim only, DON'T draw strands
const BG = arg("--bg", "FFFFFF").replace(/^#/, "").toUpperCase();   // composite background (needs final_<BG>.jpg)
const bgR = parseInt(BG.slice(0, 2), 16), bgG = parseInt(BG.slice(2, 4), 16), bgB = parseInt(BG.slice(4, 6), 16);
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--") && !/^\d/.test(a) && a !== arg("--bg", null));
if (skus.length === 0) { console.error("usage: exp_dehalo.mjs <sku> [sku...] [--strength 1.0] [--bg F7F7F7]"); process.exit(1); }

const W = 4000;
// no-strand variant gets its OWN folder + cache so it never collides with the strand-drawing output.
const OUT = "outputs/experiments/dehalo" + (NOSTRANDS ? "_nostrand" : "") + (BG === "FFFFFF" ? "" : `_${BG}`);
const exists = (p) => readFile(p).then(() => true, () => false);
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// jet-ish colormap for the blend map: 0 = blue (original), 0.5 = green (50/50), 1 = red (gemini).
const heat = (t) => [clamp(255 * smoothstep(0.4, 0.9, t)),
                     clamp(255 * (t < 0.5 ? smoothstep(0.0, 0.5, t) : smoothstep(1.0, 0.6, t))),
                     clamp(255 * smoothstep(0.6, 0.1, t))];
// tight bbox of an alpha buffer (pixels above thr)
function alphaBbox(a, W, H, thr = 128) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Ask Gemini to repaint ONLY the white edge fringe to fur color; keep everything else as-is.
// We do NOT trust it globally — only its rim pixels survive, darken-only, inside the band mask.
// Strand-drawing prompt (default, "fur edges" version) vs recolor-only prompt (--nostrands, "no fur").
const STRAND_CLAUSE = ` As you do, draw fine, short, soft fur strands right at the silhouette edge so it reads as FINISHED natural fur — a soft feathered edge, not a hard cut. Keep the strands subtle and low-contrast, and do NOT enlarge the overall shape.`;
const NOSTRAND_CLAUSE = `, so the silhouette reads as clean fur.`;
const DEHALO_INSTRUCTION = `This is a plush / soft-toy product photographed on a pure white background with a soft cast shadow.

There is a thin bright WHITE / light fringe of pixels all around the fuzzy fur silhouette — a matting halo left by background removal. Remove ONLY that white fringe: recolor those edge pixels to match the adjacent fur color${NOSTRANDS ? NOSTRAND_CLAUSE : "." + STRAND_CLAUSE}

- Keep the product body, its fur texture and color, pixel-for-pixel.
- Keep the cast shadow exactly as it is — same shape, position, opacity, color.
- Keep the white background pure white.
- Do NOT move, rescale, re-crop or recompose. Product stays in the EXACT same position and scale.`;

for (const sku of skus) {
  process.stdout.write(`${sku} ... `);
  try {
    const dir = `outputs/work/${sku}`;
    const beforeBytes = await readFile(join(dir, `final_${BG}.jpg`));
    const matteBytes = await readFile(join(dir, "matte.png"));

    // --- Gemini "remove white fringe" pass on the finished composite (2K, temp 0), saved raw ---
    //     Cache-first: reuse this folder's, else the white-bg dehalo folder's (Gemini's de-halo'd
    //     FUR is bg-independent — only the reconstructed ground below is re-toned to BG).
    const geminiPath = join(OUT, `${sku}_gemini.jpg`);
    const whiteGem = join("outputs/experiments/dehalo" + (NOSTRANDS ? "_nostrand" : ""), `${sku}_gemini.jpg`);
    let geminiBytes;
    if (await exists(geminiPath)) geminiBytes = await readFile(geminiPath);
    else if (await exists(whiteGem)) geminiBytes = await readFile(whiteGem);
    else {
      const wf = await readFile(join(dir, "final_FFFFFF.jpg")).catch(() => beforeBytes);
      const geminiRaw = await generateShadowGemini({ apiKey: K, sku, image: Buffer.from(wf), instruction: DEHALO_INSTRUCTION, temperature: 0 });
      geminiBytes = await sharp(geminiRaw).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(geminiPath, geminiBytes);   // <- the raw Gemini output, saved
    }

    // --- Load buffers at working res ---
    const before = await sharp(beforeBytes).resize(W, W).removeAlpha().raw().toBuffer();          // pipeline composite RGB
    const gemini = await sharp(geminiBytes).resize(W, W).removeAlpha().raw().toBuffer();          // Gemini de-halo'd RGB (on white, no shadow)
    const base   = await sharp(await readFile(join(dir, "shadow.jpg"))).resize(W, W).removeAlpha().raw().toBuffer(); // our shadow render (same frame)
    const A  = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();     // coverage 0..255
    const N = W * W;
    const raw = { raw: { width: W, height: W, channels: 3 } };

    // --- optional gentle relight (PRODUCT only) — same mean-normalized lightmap as the pipeline ---
    let lm = null, mean = 128;
    if (RELIGHT) {
      const relitBytes = await readFile(join(dir, "relit.jpg")).catch(() => null);
      if (relitBytes) {
        const gmap = await sharp(relitBytes).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
        lm = new Float32Array(N);
        for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(gmap[k], gmap[k + 1], gmap[k + 2]);
        let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const av = A[p] / 255; gs += lm[p] * av; aw += av; }
        mean = aw > 0 ? gs / aw : 128;
      } else process.stdout.write("(no relit.jpg — relight skipped) ");
    }

    // === GEMSHADOW — Gemini's clean product re-composited over OUR cast shadow ===========
    // Gemini removes the white fringe but returns the product on plain white (shadow deleted) and,
    // crucially, barely moves it (bbox drift ~1 px — verified). So take Gemini's product where it's
    // non-white and drop OUR shadow back onto the ground. ag = Gemini's own coverage (1=product,
    // 0=white); on the ground (ag→0) the pixel becomes our shadow-darkened background.
    const gemshadow = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const ag = 1 - smoothstep(238, 254, gray(gemini[i], gemini[i + 1], gemini[i + 2]));
      const sf = (ag * 255 + (1 - ag) * gray(base[i], base[i + 1], base[i + 2])) / 255;   // our shadow on the ground
      gemshadow[i]     = clamp(gemini[i]     * ag + bgR * sf * (1 - ag));   // ground re-toned to BG
      gemshadow[i + 1] = clamp(gemini[i + 1] * ag + bgG * sf * (1 - ag));
      gemshadow[i + 2] = clamp(gemini[i + 2] * ag + bgB * sf * (1 - ag));
    }
    await sharp(gemshadow, raw).jpeg({ quality: 95 }).toFile(join(OUT, `${sku}_gemshadow.jpg`));

    // === HYBRID (recommended) — Gemini's clean EDGE, the real product INTERIOR ===========
    // gemshadow removes the rim but redraws the whole product (face eyes/muzzle shift, blue cast).
    // The rim only lives in the fringe, so replace just a WIDE border (rim + inward margin) with
    // gemshadow and keep `before` in the deep interior — the crossover sits in SOLID fur (high
    // alpha) where the two agree, so the face stays pixel-real and there's no seam.
    //   m = 1 across the fringe+margin, 0 deep inside. Ab = heavily-blurred alpha ≈ "depth inside".
    //   (An earlier version gated the band to the product side — that kept `before`'s rim and FAILED.)
    const Ab = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").blur(18).raw().toBuffer();
    const hybrid = Buffer.alloc(N * 3);
    const maskImg = Buffer.alloc(N);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const m = (1 - smoothstep(0.72, 0.97, Ab[p] / 255)) * STRENGTH;   // 1=border (use gemshadow), 0=interior (keep before)
      maskImg[p] = clamp(m * 255);
      // product-only relight: gate by matte alpha so the ground/shadow/bg are never touched (rl≈1 there)
      const rl = lm ? 1 + ((lm[p] - mean) / 128) * RELIGHT * smoothstep(0.02, 0.20, Ab[p] / 255) : 1;
      for (let c = 0; c < 3; c++) hybrid[i + c] = clamp((before[i + c] * (1 - m) + gemshadow[i + c] * m) * rl);
    }
    await sharp(hybrid, raw).jpeg({ quality: 95 }).toFile(join(OUT, `${sku}_hybrid.jpg`));
    await sharp(maskImg, { raw: { width: W, height: W, channels: 1 } }).jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_mask.jpg`));

    // === BLEND MAP — false-color m over a grey product: blue=original, green=50/50, red=gemini ===
    const blend = Buffer.alloc(N * 3);
    const HA = 0.55;   // heatmap opacity over the grey product structure
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const [hr, hg, hb] = heat(maskImg[p] / 255);
      const g = gray(before[i], before[i + 1], before[i + 2]);
      blend[i]     = clamp(g * (1 - HA) + hr * HA);
      blend[i + 1] = clamp(g * (1 - HA) + hg * HA);
      blend[i + 2] = clamp(g * (1 - HA) + hb * HA);
    }
    await sharp(blend, raw).jpeg({ quality: 92 }).toFile(join(OUT, `${sku}_blendmap.jpg`));

    // --- Comparison at the BOTTOM contact edge (fur over the gray shadow — the region that matters) ---
    const bb = alphaBbox(A, W, W, 40);
    const cw = 1400, ch = 600;
    const ex = { left: Math.min(Math.max(0, (bb.x0 * 2 + bb.w) / 2 - cw / 2), W - cw) | 0,
                 top:  Math.min(Math.max(0, bb.y0 + bb.h - ch + 180), W - ch) | 0, width: cw, height: ch };
    const cellW = 480;
    const panels = [];
    for (const [lbl, buf] of [["before (white rim)", before], ["gemshadow (redraws face)", gemshadow], ["hybrid (recommended)", hybrid]]) {
      const img = await sharp(buf, raw).extract(ex).resize(cellW, null).png().toBuffer();
      const h = (await sharp(img).metadata()).height;
      const cap = Buffer.from(`<svg width="${cellW}" height="20"><rect width="100%" height="100%" fill="black"/><text x="6" y="15" font-family="monospace" font-size="12" fill="white">${lbl}</text></svg>`);
      panels.push(await sharp({ create: { width: cellW, height: h + 20, channels: 3, background: "#000" } }).composite([{ input: img, top: 20, left: 0 }, { input: cap, top: 0, left: 0 }]).png().toBuffer());
    }
    const ph = (await sharp(panels[0]).metadata()).height;
    await sharp({ create: { width: (cellW + 6) * panels.length, height: ph, channels: 3, background: "#222" } })
      .composite(panels.map((pn, i) => ({ input: pn, left: i * (cellW + 6), top: 0 })))
      .jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_sbs.jpg`));

    console.log(`ok  → ${OUT}/${sku}_{gemini,gemshadow,hybrid,mask,blendmap,sbs}.jpg`);
  } catch (e) {
    console.log("FAIL: " + e.message);
  }
}
