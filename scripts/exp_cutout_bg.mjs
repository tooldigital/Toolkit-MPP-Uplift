// EXPERIMENT — how dark should the background be when Gemini cleans the CUTOUT's white fringe?
// The fringe is invisible on white and stands out more the darker the background — but a too-dark
// bg can make Gemini hallucinate/alter the product. Sweep several bg levels and compare.
// Writes only to outputs/experiments/cutout_bg/.
//
//   node --env-file=.env scripts/exp_cutout_bg.mjs PE964848 [--bgs FFFFFF,8C8C8C,555555,2A2A2A,000000]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BGS = arg("--bgs", "FFFFFF,8C8C8C,555555,2A2A2A,000000").split(",").map((s) => s.replace(/^#/, ""));
const bgsVal = arg("--bgs", null);
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== bgsVal);
if (skus.length === 0) { console.error("usage: exp_cutout_bg.mjs <sku> [sku...] [--bgs ...]"); process.exit(1); }

const W = 4000;
const OUT = "outputs/experiments/cutout_bg";
await mkdir(OUT, { recursive: true });
const exists = (p) => readFile(p).then(() => true, () => false);
function bbox(a, W, H, thr = 40) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }

// Generic prompt — the bg is "neutral" so the same text works for any darkness.
const INSTRUCTION = `This is a plush / soft-toy product on a flat neutral background — no shadow.

Around the fuzzy fur silhouette there is a thin bright WHITE matting fringe left by background removal; it stands out against the background. Remove ONLY that white fringe: recolor those edge pixels to match the adjacent fur color so the silhouette reads as clean fur meeting the background.

- Keep the product body, its fur texture and color, pixel-for-pixel — do NOT restyle or invent detail.
- Keep the background flat and unchanged.
- Do NOT move, rescale, re-crop or recompose. Product stays in the EXACT same position and scale.`;

for (const sku of skus) {
  const dir = `outputs/work/${sku}`;
  const matteBytes = await readFile(join(dir, "matte.png"));
  const A = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  const bb = bbox(A, W, W, 40);
  const cw = 1300, ch = 560;
  const ex = { left: Math.min(Math.max(0, (bb.x0 * 2 + bb.w) / 2 - cw / 2), W - cw) | 0,
               top:  Math.min(Math.max(0, bb.y0 + bb.h - ch + 150), W - ch) | 0, width: cw, height: ch };

  const cols = [];   // each: [label, inputEdgeBuf, outputEdgeBuf, fullOutBuf]
  for (const bg of BGS) {
    process.stdout.write(`${sku} bg#${bg} ... `);
    const onBg = await sharp(matteBytes).resize(W, W).flatten({ background: `#${bg}` }).jpeg({ quality: 95 }).toBuffer();
    const gemPath = join(OUT, `${sku}_gem_${bg}.jpg`);
    let gem;
    if (await exists(gemPath)) gem = await readFile(gemPath);
    else {
      try {
        const rawG = await generateShadowGemini({ apiKey: K, sku, image: onBg, instruction: INSTRUCTION, temperature: 0 });
        gem = await sharp(rawG).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
        await writeFile(gemPath, gem);
      } catch (e) { console.log("FAIL " + e.message); continue; }
    }
    const inE = await sharp(await sharp(onBg).extract(ex).toBuffer()).resize(560, null).png().toBuffer();
    const outE = await sharp(await sharp(gem).extract(ex).toBuffer()).resize(560, null).png().toBuffer();
    const full = await sharp(gem).resize(300, 300, { fit: "contain", background: "#888" }).png().toBuffer();
    cols.push([bg, inE, outE, full]);
    console.log("ok");
  }
  if (!cols.length) continue;

  // Build a grid: one column per bg. Rows: [bg label] [input edge] [output edge] [full out].
  const colW = 560, gap = 6;
  const eh = (await sharp(cols[0][1]).metadata()).height;
  const cells = [];
  for (const [bg, inE, outE, full] of cols) {
    const lbl = (t) => Buffer.from(`<svg width="${colW}" height="22"><rect width="100%" height="100%" fill="black"/><text x="6" y="16" font-family="monospace" font-size="14" fill="white">${t}</text></svg>`);
    const H = 22 + eh + 22 + eh + 22 + 300;
    const col = await sharp({ create: { width: colW, height: H, channels: 3, background: "#111" } }).composite([
      { input: lbl(`bg #${bg}`), top: 0, left: 0 },
      { input: inE, top: 22, left: 0 },
      { input: lbl("gemini INPUT (edge) ↑   OUTPUT (edge) ↓"), top: 22 + eh, left: 0 },
      { input: outE, top: 22 + eh + 22, left: 0 },
      { input: full, top: 22 + eh + 22 + eh + 22, left: Math.round((colW - 300) / 2) },
    ]).png().toBuffer();
    cells.push(col);
  }
  const H = (await sharp(cells[0]).metadata()).height;
  await sharp({ create: { width: (colW + gap) * cells.length, height: H, channels: 3, background: "#222" } })
    .composite(cells.map((c, i) => ({ input: c, left: i * (colW + gap), top: 0 })))
    .jpeg({ quality: 92 }).toFile(join(OUT, `${sku}_bgsweep.jpg`));
  console.log(`→ ${OUT}/${sku}_bgsweep.jpg`);
}
