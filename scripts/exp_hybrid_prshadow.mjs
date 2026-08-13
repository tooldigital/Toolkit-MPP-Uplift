// EXPERIMENT — hybrid edge cleanup that keeps the PHOTOROOM shadow verbatim.
// Separate from the pipeline AND from exp_dehalo.mjs — writes only to
// outputs/experiments/hybrid_prshadow/ so the earlier (good) dehalo hybrids are untouched.
//
// Same mentality as the dehalo hybrid, tightened so NOTHING Gemini touches the shadow:
//   - The base is the LITERAL pipeline final (final_FFFFFF.jpg) — the real Photoroom cast shadow
//     and the real product. We never reconstruct the shadow.
//   - Gemini's clean fur is swapped in ONLY where two things hold: (a) we're in the thin silhouette
//     border, AND (b) Gemini says that pixel is product (not ground). Everywhere else — the whole
//     interior and the entire ground/shadow — is the pipeline final, byte-for-byte.
//   So the cast shadow is 100% Photoroom; Gemini only repaints the fur edge that carried the rim.
//
// Reuses the cached Gemini "remove white fringe" output from outputs/experiments/dehalo/<sku>_gemini.jpg
// (generates it if missing). Reads final_FFFFFF.jpg + matte.png from outputs/work/<sku>/. Writes:
//   <sku>_hybrid_pr.jpg — final: pipeline shadow + Gemini fur edge only          ← the result
//   <sku>_mask.jpg      — swap mask k = border ∧ gemini-is-product
//   <sku>_sbs.jpg       — bottom-edge zoom: pipeline final | dehalo hybrid | hybrid_pr
//
//   node --env-file=.env scripts/exp_hybrid_prshadow.mjs PE964848 [sku...]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
// Band width: R = alpha blur radius (bigger ⇒ wider swap band, reaches a rim that sits further inward).
// e0/e1 = smoothstep edges on the blurred alpha (m=1 where blurAlpha<e0 → border; m=0 where >e1 → interior).
const R = parseInt(arg("--R", "18"), 10);
const E0 = parseFloat(arg("--e0", "0.72")), E1 = parseFloat(arg("--e1", "0.97"));
const BG = arg("--bg", "FFFFFF").replace(/^#/, "").toUpperCase();   // composite background (needs final_<BG>.jpg)
const bgR = parseInt(BG.slice(0, 2), 16), bgG = parseInt(BG.slice(2, 4), 16), bgB = parseInt(BG.slice(4, 6), 16);
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== arg("--bg", null));
if (skus.length === 0) { console.error("usage: exp_hybrid_prshadow.mjs <sku> [sku...] [--bg F7F7F7]"); process.exit(1); }

const W = 4000;
// non-white bg → its own folder so the white results aren't overwritten
const OUT = "outputs/experiments/hybrid_prshadow" + (BG === "FFFFFF" ? "" : `_${BG}`);
const DEHALO = "outputs/experiments/dehalo";   // reuse its cached Gemini fringe-clean + old hybrid
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// jet-ish colormap for the blend map: 0 = blue (original/photoroom), 0.5 = green, 1 = red (gemini fur).
const heat = (t) => [clamp(255 * smoothstep(0.4, 0.9, t)),
                     clamp(255 * (t < 0.5 ? smoothstep(0.0, 0.5, t) : smoothstep(1.0, 0.6, t))),
                     clamp(255 * smoothstep(0.6, 0.1, t))];
const exists = (p) => readFile(p).then(() => true, () => false);
function bbox(a, W, H, thr = 40) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }

const DEHALO_INSTRUCTION = `This is a plush / soft-toy product photographed on a white background with a soft cast shadow.

There is a thin bright WHITE / light fringe of pixels all around the fuzzy fur silhouette — a matting halo left by background removal. Remove ONLY that white fringe: recolor those edge pixels to match the adjacent fur color, so the silhouette reads as clean fur.

- Keep the product body, its fur texture and color, pixel-for-pixel.
- Keep the cast shadow exactly as it is — same shape, position, opacity, color.
- Keep the white background pure white.
- Do NOT move, rescale, re-crop or recompose. Product stays in the EXACT same position and scale.`;

for (const sku of skus) {
  process.stdout.write(`${sku} ... `);
  try {
    const dir = `outputs/work/${sku}`;
    const beforeBytes = await readFile(join(dir, `final_${BG}.jpg`));    // pipeline final on the target bg (shadow + product)
    const matteBytes = await readFile(join(dir, "matte.png"));
    const shadowBytes = await readFile(join(dir, "shadow.jpg"));          // Photoroom shadow render (for re-grounding Gemini's edge)

    // Gemini fringe-clean of the composite — reuse dehalo's cached output, else generate.
    let gemBytes;
    const dehaloGem = join(DEHALO, `${sku}_gemini.jpg`);
    if (await exists(dehaloGem)) gemBytes = await readFile(dehaloGem);
    else {
      if (!K) throw new Error("GEMINI_KEY needed (no cached dehalo gemini output)");
      const rawG = await generateShadowGemini({ apiKey: K, sku, image: Buffer.from(beforeBytes), instruction: DEHALO_INSTRUCTION, temperature: 0 });
      gemBytes = await sharp(rawG).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
      await writeFile(join(OUT, `${sku}_gemini.jpg`), gemBytes);
    }

    const before = await sharp(beforeBytes).resize(W, W).removeAlpha().raw().toBuffer();   // real Photoroom shadow + product
    const gem    = await sharp(gemBytes).resize(W, W).removeAlpha().raw().toBuffer();       // Gemini-cleaned product (on white — shadow deleted)
    const base   = await sharp(shadowBytes).resize(W, W).removeAlpha().raw().toBuffer();     // Photoroom shadow render
    const A      = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();      // real product coverage
    const Ab     = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").blur(R).raw().toBuffer();
    const N = W * W;
    const raw = { raw: { width: W, height: W, channels: 3 } };

    // The dehalo hybrid worked by REPLACING the whole silhouette border with Gemini's clean fur.
    // Gemini only draws a clean dark edge when it sees the shadow, so we use the composite Gemini
    // (dehalo _gemini.jpg). Two things keep the shadow 100% Photoroom:
    //   - COVERAGE comes from the MATTE alpha (As), never from Gemini — so Gemini's invented gray
    //     shadow can't be read as product and pulled onto the ground (the otter bug).
    //   - GROUND comes from the Photoroom shadow render (base), re-toned to the target bg: base is
    //     rendered on WHITE, so base·(bgC/255) turns its white ground into the bg's shade while
    //     keeping the shadow's darkening. So in the border we lay Gemini's fur over the bg-shaded
    //     Photoroom shadow: gemOverShadow = gem·As + baseBg·(1-As).
    // Then the wide border replaces `before` entirely (no rim/halo bleed); the interior stays real.
    const bg = [bgR, bgG, bgB];
    const out = Buffer.alloc(N * 3);
    const maskImg = Buffer.alloc(N);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const m  = 1 - smoothstep(E0, E1, Ab[p] / 255);   // silhouette border (width set by --R/--e0/--e1)
      const As = smoothstep(0.10, 0.55, A[p] / 255);        // matte product coverage (clean: no Gemini shadow)
      maskImg[p] = clamp(m * 255);
      for (let c = 0; c < 3; c++) {
        const baseBg = base[i + c] * (bg[c] / 255);                        // white shadow render → bg-shaded
        const gemOverShadow = gem[i + c] * As + baseBg * (1 - As);         // Gemini fur over bg-shaded Photoroom shadow
        out[i + c] = clamp(before[i + c] * (1 - m) + gemOverShadow * m);
      }
    }
    await sharp(out, raw).jpeg({ quality: 95 }).toFile(join(OUT, `${sku}_hybrid_pr.jpg`));
    await sharp(maskImg, { raw: { width: W, height: W, channels: 1 } }).jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_mask.jpg`));

    // BLEND MAP — false-color the border mask m (the blend weight between the original interior and
    // the swapped silhouette edge) over a grey product:
    //   blue = original interior, green = the crossover band, red = swapped border (Gemini edge).
    const blend = Buffer.alloc(N * 3);
    const HA = 0.55;
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const [hr, hg, hb] = heat(maskImg[p] / 255);
      const g = gray(before[i], before[i + 1], before[i + 2]);
      blend[i]     = clamp(g * (1 - HA) + hr * HA);
      blend[i + 1] = clamp(g * (1 - HA) + hg * HA);
      blend[i + 2] = clamp(g * (1 - HA) + hb * HA);
    }
    await sharp(blend, raw).jpeg({ quality: 92 }).toFile(join(OUT, `${sku}_blendmap.jpg`));

    // bottom-edge comparison: pipeline final | dehalo hybrid (if present) | hybrid_pr
    const bb = bbox(A, W, W, 40);
    const cw = 1200, ch = 560;
    const ex = { left: Math.min(Math.max(0, (bb.x0 * 2 + bb.w) / 2 - cw / 2), W - cw) | 0,
                 top:  Math.min(Math.max(0, bb.y0 + bb.h - ch + 150), W - ch) | 0, width: cw, height: ch };
    const cmp = [["pipeline final", join(dir, `final_${BG}.jpg`)]];
    cmp.push([`hybrid_pr (photoroom shadow, bg ${BG})`, join(OUT, `${sku}_hybrid_pr.jpg`)]);
    const cellW = 560, panels = [];
    for (const [lbl, f] of cmp) {
      const img = await sharp(f).resize(W, W).extract(ex).png().toBuffer();
      const cap = Buffer.from(`<svg width="${cw}" height="20"><rect width="100%" height="100%" fill="black"/><text x="6" y="15" font-family="monospace" font-size="13" fill="white">${lbl}</text></svg>`);
      const cell = await sharp({ create: { width: cw, height: ch + 20, channels: 3, background: "#000" } }).composite([{ input: img, top: 20, left: 0 }, { input: cap, top: 0, left: 0 }]).png().toBuffer();
      panels.push(await sharp(cell).resize(cellW, null).png().toBuffer());
    }
    const ph = (await sharp(panels[0]).metadata()).height;
    await sharp({ create: { width: (cellW + 6) * panels.length, height: ph, channels: 3, background: "#222" } })
      .composite(panels.map((pn, i) => ({ input: pn, left: i * (cellW + 6), top: 0 }))).jpeg({ quality: 92 }).toFile(join(OUT, `${sku}_sbs.jpg`));

    console.log(`ok  → ${OUT}/${sku}_{hybrid_pr,mask,blendmap,sbs}.jpg`);
  } catch (e) {
    console.log("FAIL: " + e.message);
  }
}
