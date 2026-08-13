// EXPERIMENT — does asking Gemini to ADD fine fur texture at the edge (while removing the white
// fringe) improve the plush silhouette? Writes only to outputs/experiments/fur_edge/.
//
// Three prompt variants, everything else identical to the grey hybrid_pr composite:
//   A recolor  — BASELINE: recolor the white fringe to fur color (current dehalo prompt).
//   B strands  — recolor + reintroduce fine, short, low-contrast fur strands AT the edge
//                (must NOT extend the overall shape).
//   C wispy    — recolor + let a few thin hairs break slightly PAST the silhouette into the white.
//
// For each SKU + variant it saves the RAW Gemini output and the COMPOSITED grey result, then a
// per-SKU edge-crop sheet with two rows:
//   row 1 (RAW)  — what Gemini drew        (A | B | C)
//   row 2 (COMP) — what survives the matte-masked composite (A | B | C)
// The point of showing both: coverage comes from the MATTE, never Gemini (the otter-bug guard), so
// C's outward wisps land where matte alpha≈0 and get masked out — visible in RAW, gone in COMP.
//
// Inputs (all cached, per SKU under outputs/work/<sku>/):
//   final_FFFFFF.jpg — white composite fed to Gemini (same input the dehalo clean used)
//   final_F7F7F7.jpg — grey no-relight composite = the `before`/base for the composite
//   matte.png        — product coverage (alpha) + bbox for the crop
// Variant A reuses the cached outputs/experiments/dehalo/<sku>_gemini.jpg (no new Gemini call).
//
//   node --env-file=.env scripts/exp_fur_edge.mjs PE964848 [sku...] [--force]

import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const FORCE = process.argv.includes("--force");
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (skus.length === 0) { console.error("usage: exp_fur_edge.mjs <sku> [sku...] [--force]"); process.exit(1); }

const W = 4000;
const OUT = "outputs/experiments/fur_edge";
const DEHALO = "outputs/experiments/dehalo";
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);
function bbox(a, W, H, thr = 40) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }

const HEAD = `This is a plush / soft-toy product photographed on a pure white background with a soft cast shadow.

There is a thin bright WHITE / light fringe of pixels all around the fuzzy fur silhouette — a matting halo left by background removal. Remove ONLY that white fringe: recolor those edge pixels to match the adjacent fur color`;
const KEEP = `
- Keep the product body, its fur texture and color, pixel-for-pixel.
- Keep the cast shadow exactly as it is — same shape, position, opacity, color.
- Keep the white background pure white.
- Do NOT move, rescale, re-crop or recompose. Product stays in the EXACT same position and scale.`;

const PROMPTS = {
  A: `${HEAD}, so the silhouette reads as clean fur meeting white.\n${KEEP}`,
  B: `${HEAD}. As you do, reintroduce very fine, short, LOW-CONTRAST fur strands right at the silhouette edge so it reads as soft natural fur rather than a hard cut. Keep the strands subtle and DO NOT enlarge or extend the overall shape — the outer silhouette must stay exactly where it is.\n${KEEP}`,
  C: `${HEAD}. Then feather the edge: let a few thin, sparse, wispy hair strands break slightly PAST the silhouette into the white, so the fur edge looks natural and soft rather than a hard cut. Keep them fine and low-contrast.\n${KEEP}`,
};
const LABEL = { A: "A recolor (baseline)", B: "B +fine strands", C: "C +wispy (breaks edge)" };

// grey hybrid_pr composite: clean Gemini fur edge over the grey no-relight composite.
async function composite(beforeBuf, gemBuf, matteBuf) {
  const before = await sharp(beforeBuf).resize(W, W).removeAlpha().raw().toBuffer();
  const gem    = await sharp(gemBuf).resize(W, W).removeAlpha().raw().toBuffer();
  const A      = await sharp(matteBuf).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  const Ab     = await sharp(matteBuf).resize(W, W).ensureAlpha().extractChannel("alpha").blur(18).raw().toBuffer();
  const N = W * W, out = Buffer.alloc(N * 3);
  for (let p = 0, i = 0; p < N; p++, i += 3) {
    const m  = 1 - smoothstep(0.72, 0.97, Ab[p] / 255);
    const As = smoothstep(0.10, 0.55, A[p] / 255);
    for (let c = 0; c < 3; c++) {
      const g = gem[i + c] * As + before[i + c] * (1 - As);
      out[i + c] = clamp(before[i + c] * (1 - m) + g * m);
    }
  }
  return sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

for (const sku of skus) {
  process.stdout.write(`${sku} ...\n`);
  try {
    const dir = `outputs/work/${sku}`;
    const whiteIn = await readFile(join(dir, "final_FFFFFF.jpg"));   // Gemini input
    const grey    = await readFile(join(dir, "final_F7F7F7.jpg"));   // grey no-relight base
    const matte   = await readFile(join(dir, "matte.png"));

    const raw = {}, comp = {};
    for (const v of ["A", "B", "C"]) {
      const gp = join(OUT, `${sku}_gem_${v}.jpg`);
      let gemBytes;
      if (!FORCE && await exists(gp)) { gemBytes = await readFile(gp); }
      else {
        process.stdout.write(`  gemini ${v} ...`);
        const g = await generateShadowGemini({ apiKey: K, sku, image: Buffer.from(whiteIn), instruction: PROMPTS[v], temperature: 0 });
        gemBytes = await sharp(g).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
        await writeFile(gp, gemBytes);
        process.stdout.write(" ok\n");
      }
      raw[v] = gemBytes;
      const cp = join(OUT, `${sku}_comp_${v}.jpg`);
      const c = await composite(grey, gemBytes, matte);
      await writeFile(cp, c);
      comp[v] = c;
    }

    // edge-crop sheet: crop a window over the TOP of the silhouette (wispy fur + fringe).
    const Aalpha = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const bb = bbox(Aalpha, W, W, 40);
    const cw = 1100, ch = 900;
    const cx = (bb.x0 + bb.w / 2) | 0;
    const ex = { left: Math.min(Math.max(0, cx - cw / 2), W - cw) | 0,
                 top:  Math.min(Math.max(0, bb.y0 - 60), W - ch) | 0, width: cw, height: ch };
    const cellW = 520;
    const cap = (t) => Buffer.from(`<svg width="${cw}" height="30"><rect width="100%" height="100%" fill="black"/><text x="8" y="21" font-family="monospace" font-size="18" fill="white">${t}</text></svg>`);
    const cell = async (buf, t) => {
      const img = await sharp(buf).resize(W, W).extract(ex).png().toBuffer();
      const c = await sharp({ create: { width: cw, height: ch + 30, channels: 3, background: "#000" } })
        .composite([{ input: img, top: 30, left: 0 }, { input: cap(t), top: 0, left: 0 }]).png().toBuffer();
      return sharp(c).resize(cellW, null).png().toBuffer();
    };
    const rowRaw  = await Promise.all(["A", "B", "C"].map((v) => cell(raw[v],  `RAW  ${LABEL[v]}`)));
    const rowComp = await Promise.all(["A", "B", "C"].map((v) => cell(comp[v], `COMP ${LABEL[v]}`)));
    const rh = (await sharp(rowRaw[0]).metadata()).height;
    const stripW = (cellW + 6) * 3;
    const strip = (cells, top) => cells.map((pn, i) => ({ input: pn, left: i * (cellW + 6), top }));
    await sharp({ create: { width: stripW, height: rh * 2 + 6, channels: 3, background: "#222" } })
      .composite([...strip(rowRaw, 0), ...strip(rowComp, rh + 6)])
      .jpeg({ quality: 92 }).toFile(join(OUT, `${sku}_sheet.jpg`));
    console.log(`  ok → ${OUT}/${sku}_sheet.jpg`);
  } catch (e) {
    console.log("  FAIL: " + e.message);
  }
}
