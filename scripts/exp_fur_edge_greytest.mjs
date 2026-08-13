// EXPERIMENT — does background CONTRAST recover the white paw fur edge that vanishes on white?
// Regenerates the Gemini clean of PE371748 flattened on a grey bg (so white fur has contrast at
// extraction time), then band-composites (R=90) and crops the bottom paws to compare vs the white run.
//
// Gem is generated on the SAME grey it will sit on, so the band composite's surround is that grey and
// the paw edge is sourced from the grey gem. subj (interior) = matte RGB. out = subj*(a*I)+gem*(1-a*I).
//
//   node --env-file=.env scripts/exp_fur_edge_greytest.mjs PE371748 [--bgs F7F7F7,8C8C8C] [--R 90]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const sku = process.argv[2];
const BGS = arg("--bgs", "F7F7F7,8C8C8C").split(",").map((s) => s.replace(/^#/, "").toUpperCase());
const R = parseInt(arg("--R", "90"), 10);
if (!sku || sku.startsWith("--")) { console.error("usage: exp_fur_edge_greytest.mjs <sku> [--bgs ..] [--R ..]"); process.exit(1); }

const W = 4000;
const OUT = "outputs/experiments/fur_edge";
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
function bbox(a, W, H, thr = 40) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }
const exists = (p) => readFile(p).then(() => true, () => false);
const prompt = (hex) => `This is a plush cat toy photographed on a solid grey #${hex} background.

Clean the fuzzy silhouette edge all around: remove any pale/white matting fringe, and reintroduce very fine, short, low-contrast fur strands right at the edge (especially on the light/white paws and chest) so the whole outline reads as soft natural fur — NOT a hard cut.
- Keep the product body, its fur texture and color, pixel-for-pixel. Do NOT enlarge or extend the overall shape.
- Keep the background a solid, even grey of the SAME colour #${hex}.
- Do NOT move, rescale, re-crop or recompose.`;

const dir = `outputs/work/${sku}`;
const matte = await readFile(join(dir, "matte.png"));
const subj = await sharp(matte).resize(W, W).removeAlpha().raw().toBuffer();
const a  = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
const Ab = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(R).raw().toBuffer();
const N = W * W;

const compOf = {};
for (const hex of BGS) {
  const gp = join(OUT, `${sku}_gemgrey_${hex}.jpg`);
  let gemBytes;
  if (await exists(gp)) gemBytes = await readFile(gp);
  else {
    // flatten the product on the grey bg → Gemini input (this is where contrast matters)
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    const onGrey = await sharp(matte).resize(W, W).flatten({ background: { r, g, b } }).jpeg({ quality: 95 }).toBuffer();
    process.stdout.write(`  gemini on #${hex} ...`);
    const raw = await generateShadowGemini({ apiKey: K, sku, image: onGrey, instruction: prompt(hex), temperature: 0 });
    gemBytes = await sharp(raw).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
    await writeFile(gp, gemBytes);
    process.stdout.write(" ok\n");
  }
  const gem = await sharp(gemBytes).resize(W, W).removeAlpha().raw().toBuffer();
  const out = Buffer.alloc(N * 3);
  for (let p = 0, i = 0; p < N; p++, i += 3) {
    const I = smoothstep(0.55, 0.92, Ab[p] / 255);
    const pw = (a[p] / 255) * I;
    for (let c = 0; c < 3; c++) out[i + c] = clamp(subj[i + c] * pw + gem[i + c] * (1 - pw));
  }
  const buf = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  await writeFile(join(OUT, `${sku}_greytest_${hex}.jpg`), buf);
  compOf[hex] = buf;
  console.log(`  comp #${hex} → ${OUT}/${sku}_greytest_${hex}.jpg`);
}

// paw crop comparison: white band_90 | each grey test — bottom-centre paws
const bb = bbox(a, W, W, 40);
const cw = 1500, ch = 1100;
const ex = { left: Math.min(Math.max(0, (bb.x0 + bb.w / 2 - cw / 2) | 0), W - cw), top: Math.min(Math.max(0, bb.y0 + bb.h - ch + 40), W - ch), width: cw, height: ch };
const cellW = 560;
const cap = (t) => Buffer.from(`<svg width="${cw}" height="34"><rect width="100%" height="100%" fill="black"/><text x="10" y="24" font-family="monospace" font-size="22" fill="white">${t}</text></svg>`);
const cell = async (src, t) => { const img = await sharp(src).resize(W, W).extract(ex).png().toBuffer(); const c = await sharp({ create: { width: cw, height: ch + 34, channels: 3, background: "#000" } }).composite([{ input: img, top: 34, left: 0 }, { input: cap(t), top: 0, left: 0 }]).png().toBuffer(); return sharp(c).resize(cellW, null).png().toBuffer(); };
const panels = [await cell(join(OUT, `${sku}_band_90.jpg`), "white bg (band R=90)")];
for (const hex of BGS) panels.push(await cell(compOf[hex], `#${hex} gem`));
const ph = (await sharp(panels[0]).metadata()).height;
await sharp({ create: { width: (cellW + 6) * panels.length, height: ph, channels: 3, background: "#222" } })
  .composite(panels.map((pn, i) => ({ input: pn, left: i * (cellW + 6), top: 0 })))
  .jpeg({ quality: 92 }).toFile(join(OUT, `${sku}_greytest_paws.jpg`));
console.log(`paw compare → ${OUT}/${sku}_greytest_paws.jpg`);
