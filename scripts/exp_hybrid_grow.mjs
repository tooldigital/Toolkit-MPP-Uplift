// EXPERIMENT — like hybrid_prshadow, but Gemini is allowed to REGENERATE fur at the edge and
// extend a few wisps OUTWARD past the clipped silhouette. Writes only to
// outputs/experiments/hybrid_grow[_<BG>]/ — pipeline + other experiments untouched.
//
// Difference vs hybrid_prshadow:
//   - hybrid_prshadow takes COVERAGE from the MATTE alpha, so nothing can appear OUTSIDE the
//     cut silhouette — Gemini can only recolor the existing fringe, never grow fur outward.
//   - here we take coverage from GEMINI (its fur-on-white brightness), but CONFINE it to a
//     dilated ring around the silhouette (`nearSil`) so its invented far-field cast shadow can
//     never be read as product (the "otter bug"). Inside the ring, extended wisps survive.
//
// Kept 100% real: the deep interior (before) and the Photoroom cast shadow everywhere outside
// the ring. Gemini owns only the thin edge-and-outward band — "we don't care about small fur
// border inconsistencies there" (they sit in fur, against the interior we keep pixel-for-pixel).
//
// Reads final_<BG>.jpg + final_FFFFFF.jpg + matte.png + shadow.jpg from outputs/work/<sku>/.
// Gemini "grow fur" pass is cached as <sku>_gemini_grow.jpg (temp 0). Writes:
//   <sku>_grow.jpg      — the result (real interior + Photoroom shadow + Gemini-grown edge)
//   <sku>_gemini_grow.jpg — raw Gemini grow output (on white), saved
//   <sku>_mask.jpg      — the ring band m
//   <sku>_sbs.jpg       — bottom-edge zoom: hybrid_pr | grow
//
//   node --env-file=.env scripts/exp_hybrid_grow.mjs PE317642 [sku...] [--bg F7F7F7] [--reach 24]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BG = arg("--bg", "FFFFFF").replace(/^#/, "").toUpperCase();
const bgR = parseInt(BG.slice(0, 2), 16), bgG = parseInt(BG.slice(2, 4), 16), bgB = parseInt(BG.slice(4, 6), 16);
const REACH = parseFloat(arg("--reach", "24"));   // blur sigma for the outward reach of the ring
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== arg("--bg", null) && a !== arg("--reach", null));
if (skus.length === 0) { console.error("usage: exp_hybrid_grow.mjs <sku> [sku...] [--bg F7F7F7] [--reach 24]"); process.exit(1); }

const W = 4000;
const OUT = "outputs/experiments/hybrid_grow" + (BG === "FFFFFF" ? "" : `_${BG}`);
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);
function bbox(a, W, H, thr = 40) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }

// Ask Gemini to remove the fringe AND regrow a few fur wisps OUTWARD — but touch only the edge.
const GROW_INSTRUCTION = `This is a plush / soft-toy product photographed on a pure white background with a soft cast shadow.

Around the fuzzy fur silhouette there is a thin bright WHITE matting fringe (a halo left by background removal), and the outermost fur has been clipped to a flat, cut-out edge.

Fix the silhouette EDGE only, doing two things:
1. Remove the white fringe — recolor those edge pixels to the adjacent fur color.
2. Redraw natural fur at the very edge: let soft individual fur wisps extend a SHORT distance OUTWARD into the white, so the outline reads as real, slightly irregular fur rather than a cut line.

- Change ONLY the outer edge. Keep the product body interior, its fur texture and color, pixel-for-pixel.
- Keep the cast shadow exactly as it is — same shape, position, opacity, color. Do NOT draw fur over the shadow.
- Keep the background pure white.
- Do NOT move, rescale, re-crop, or recompose. Product stays in the EXACT same position and scale.`;

for (const sku of skus) {
  process.stdout.write(`${sku} ... `);
  try {
    const dir = `outputs/work/${sku}`;
    const beforeBytes = await readFile(join(dir, `final_${BG}.jpg`));           // real interior + Photoroom shadow on target bg
    const whiteBytes = await readFile(join(dir, "final_FFFFFF.jpg")).catch(() => beforeBytes);  // feed Gemini the WHITE composite
    const matteBytes = await readFile(join(dir, "matte.png"));
    const shadowBytes = await readFile(join(dir, "shadow.jpg"));

    // Gemini "grow fur" pass (temp 0), cached per-SKU (bg-independent — it works on white).
    let gemBytes;
    const gp = join(OUT, `${sku}_gemini_grow.jpg`);
    if (await exists(gp)) gemBytes = await readFile(gp);
    else {
      if (!K) throw new Error("GEMINI_KEY needed");
      const rawG = await generateShadowGemini({ apiKey: K, sku, image: Buffer.from(whiteBytes), instruction: GROW_INSTRUCTION, temperature: 0 });
      gemBytes = await sharp(rawG).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(gp, gemBytes);
    }

    const before = await sharp(beforeBytes).resize(W, W).removeAlpha().raw().toBuffer();
    const gem    = await sharp(gemBytes).resize(W, W).removeAlpha().raw().toBuffer();
    const base   = await sharp(shadowBytes).resize(W, W).removeAlpha().raw().toBuffer();
    const Ab = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").blur(18).raw().toBuffer();     // interior depth
    const Ao = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").blur(REACH).raw().toBuffer();  // outward reach
    const N = W * W;
    const raw = { raw: { width: W, height: W, channels: 3 } };
    const bg = [bgR, bgG, bgB];

    const out = Buffer.alloc(N * 3);
    const maskImg = Buffer.alloc(N);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      // nearSil: 1 across the silhouette + a short outward reach, decaying to 0 far outside.
      const nearSil = smoothstep(3, 90, Ao[p]);
      // notDeep: 0 deep in the body, 1 at the edge/outside — so we never touch the interior.
      const notDeep = 1 - smoothstep(0.72, 0.97, Ab[p] / 255);
      const m = nearSil * notDeep;                              // the edge-and-outward ring
      maskImg[p] = clamp(m * 255);
      // Gemini coverage (fur = non-white), CONFINED to the ring so far-field shadow can't count.
      const ag = (1 - smoothstep(238, 254, gray(gem[i], gem[i + 1], gem[i + 2]))) * nearSil;
      for (let c = 0; c < 3; c++) {
        const baseBg = base[i + c] * (bg[c] / 255);             // Photoroom shadow render → bg-shaded ground
        const gemLayer = gem[i + c] * ag + baseBg * (1 - ag);   // grown fur over the re-toned ground
        out[i + c] = clamp(before[i + c] * (1 - m) + gemLayer * m);
      }
    }
    await sharp(out, raw).jpeg({ quality: 95 }).toFile(join(OUT, `${sku}_grow.jpg`));
    await sharp(maskImg, { raw: { width: W, height: W, channels: 1 } }).jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_mask.jpg`));

    // bottom-edge zoom: hybrid_pr (if present) | grow
    const A = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const bb = bbox(A, W, W, 40);
    const cw = 1200, ch = 560;
    const ex = { left: Math.min(Math.max(0, (bb.x0 * 2 + bb.w) / 2 - cw / 2), W - cw) | 0,
                 top:  Math.min(Math.max(0, bb.y0 + bb.h - ch + 150), W - ch) | 0, width: cw, height: ch };
    const prPath = join("outputs/experiments/hybrid_prshadow" + (BG === "FFFFFF" ? "" : `_${BG}`), `${sku}_hybrid_pr.jpg`);
    const cmp = [];
    if (await exists(prPath)) cmp.push(["hybrid_pr (recolor edge)", prPath]);
    cmp.push(["grow (regrow wisps outward)", join(OUT, `${sku}_grow.jpg`)]);
    const cellW = 560, panels = [];
    for (const [lbl, f] of cmp) {
      const img = await sharp(f).resize(W, W).extract(ex).png().toBuffer();
      const cap = Buffer.from(`<svg width="${cw}" height="20"><rect width="100%" height="100%" fill="black"/><text x="6" y="15" font-family="monospace" font-size="13" fill="#0f0">${lbl}</text></svg>`);
      const cell = await sharp({ create: { width: cw, height: ch + 20, channels: 3, background: "#000" } }).composite([{ input: img, top: 20, left: 0 }, { input: cap, top: 0, left: 0 }]).png().toBuffer();
      panels.push(await sharp(cell).resize(cellW, null).png().toBuffer());
    }
    const ph = (await sharp(panels[0]).metadata()).height;
    await sharp({ create: { width: (cellW + 6) * panels.length, height: ph, channels: 3, background: "#222" } })
      .composite(panels.map((pn, i) => ({ input: pn, left: i * (cellW + 6), top: 0 }))).jpeg({ quality: 92 }).toFile(join(OUT, `${sku}_sbs.jpg`));

    console.log(`ok  → ${OUT}/${sku}_{grow,gemini_grow,mask,sbs}.jpg`);
  } catch (e) {
    console.log("FAIL: " + e.message);
  }
}
