// EXPERIMENT — control the DIRECTION of the otter's Gemini cast shadow (flat product, blank Photoroom
// shadow). The dehalo hybrid passes Gemini's de-halo shadow straight through, so the direction is
// whatever Gemini improvised — currently it pools below/foreground. Here we test explicit prompts that
// place the shadow BEHIND the product and to the RIGHT (front-left key light), and composite each with
// the exact dehalo --nostrands --relight 0.08 math. Writes only to outputs/experiments/otter_shadow/.
//
//   node --env-file=.env scripts/exp_otter_shadow.mjs [PE936323] [--force]
//
// --force re-hits Gemini for every variant (default: reuse this folder's cached per-variant output).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadowGemini } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const FORCE = process.argv.includes("--force");
const SKU = process.argv.slice(2).find((a) => /^PE/i.test(a)) || "PE936323";
const BG = "F7F7F7", W = 4000;
const [bgR, bgG, bgB] = [0xf7, 0xf7, 0xf7];
const OUT = "outputs/experiments/otter_shadow";
await mkdir(OUT, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// recolor-only de-halo (no strands) + an explicit cast-shadow direction clause per variant.
const RECOLOR = `This is a plush / soft-toy product photographed on a pure white background.

There is a thin bright WHITE / light fringe of pixels all around the fuzzy fur silhouette — a matting halo left by background removal. Remove ONLY that white fringe: recolor those edge pixels to match the adjacent fur color, so the silhouette reads as clean fur.

- Keep the product body, its fur texture and color, pixel-for-pixel.
- Do NOT move, rescale, re-crop or recompose. The product stays in the EXACT same position and scale.`;

// The otter lies horizontally: head at the RIGHT, tail trailing to the lower-LEFT. Key light front-left.
const SHADOWS = {
  cur: null,  // "cur" = reuse the current shipped de-halo output (no new call): the baseline direction
  right: `

Add ONE soft, diffuse, neutral-grey cast shadow on the white floor beneath the product. The product is lit from the FRONT-LEFT, so its shadow must fall BEHIND the product and to the RIGHT — hugging the far (top) edge of the body and spilling to the right, NOT pooling toward the camera at the bottom. Keep it soft and low-contrast; the near/front edge of the product should sit almost shadow-free.`,
  behindRight: `

Ground the product with ONE soft neutral-grey cast shadow on the floor. Light comes from the upper-FRONT-LEFT. Place the shadow so it reads as cast BEHIND the product (on the far side, away from the camera) and drifting to the RIGHT, tucked close under the body's back edge. Do NOT draw any shadow in front of / below the product toward the viewer. Soft edges, low contrast, one shadow only.`,
  hardKey: `

The product rests on a white floor lit by a single soft key light from the upper LEFT and slightly FRONT. Render ONE realistic soft cast shadow consistent with that light: it falls to the lower-RIGHT and BEHIND the product, anchored at the contact line under the body. It must be one continuous soft shadow (no shadow toward the camera, no second shadow). Neutral grey, low contrast.`,
};

// dehalo --nostrands --relight 0.08 composite, given a de-halo'd Gemini frame.
async function compose(sku, geminiBytes) {
  const dir = `outputs/work/${sku}`;
  const before = await sharp(await readFile(join(dir, `final_${BG}.jpg`))).resize(W, W).removeAlpha().raw().toBuffer();
  const gemini = await sharp(geminiBytes).resize(W, W).removeAlpha().raw().toBuffer();
  const base = await sharp(await readFile(join(dir, "shadow.jpg"))).resize(W, W).removeAlpha().raw().toBuffer();
  const A = await sharp(await readFile(join(dir, "matte.png"))).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  const Ab = await sharp(await readFile(join(dir, "matte.png"))).resize(W, W).ensureAlpha().extractChannel("alpha").blur(18).raw().toBuffer();
  const N = W * W;
  // product-only relight lightmap
  const gmap = await sharp(await readFile(join(dir, "relit.jpg"))).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
  const lm = new Float32Array(N);
  for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(gmap[k], gmap[k + 1], gmap[k + 2]);
  let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const av = A[p] / 255; gs += lm[p] * av; aw += av; }
  const mean = aw > 0 ? gs / aw : 128;
  const out = Buffer.alloc(N * 3);
  for (let p = 0, i = 0; p < N; p++, i += 3) {
    const ag = 1 - smoothstep(238, 254, gray(gemini[i], gemini[i + 1], gemini[i + 2]));
    const sf = (ag * 255 + (1 - ag) * gray(base[i], base[i + 1], base[i + 2])) / 255;
    const m = 1 - smoothstep(0.72, 0.97, Ab[p] / 255);
    const rl = 1 + ((lm[p] - mean) / 128) * 0.08 * smoothstep(0.02, 0.20, Ab[p] / 255);
    for (let c = 0; c < 3; c++) {
      const bg = c === 0 ? bgR : c === 1 ? bgG : bgB;
      const gemshadow = gemini[i + c] * ag + bg * sf * (1 - ag);
      out[i + c] = clamp((before[i + c] * (1 - m) + gemshadow * m) * rl);
    }
  }
  return sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

const results = [];
for (const [key, clause] of Object.entries(SHADOWS)) {
  process.stdout.write(`${SKU} ${key} ... `);
  try {
    let geminiBytes;
    if (key === "cur") {
      geminiBytes = await readFile(`outputs/experiments/dehalo_nostrand_${BG}/${SKU}_gemini.jpg`);
    } else {
      const gp = join(OUT, `${SKU}_gem_${key}.jpg`);
      if (!FORCE && await readFile(gp).then(() => true, () => false)) geminiBytes = await readFile(gp);
      else {
        const wf = await readFile(`outputs/work/${SKU}/final_FFFFFF.jpg`);
        const g = await generateShadowGemini({ apiKey: K, sku: SKU, image: Buffer.from(wf), instruction: RECOLOR + clause, temperature: 0 });
        geminiBytes = await sharp(g).resize(W, W, { fit: "fill" }).jpeg({ quality: 95 }).toBuffer();
        await writeFile(gp, geminiBytes);
      }
    }
    const comp = await compose(SKU, geminiBytes);
    await writeFile(join(OUT, `${SKU}_${key}.jpg`), comp);
    results.push([key, comp]);
    console.log("ok");
  } catch (e) { console.log("FAIL: " + e.message); }
}

// comparison sheet
const cw = 760;
const cells = [];
for (const [key, buf] of results) {
  const img = await sharp(buf).resize(cw, cw, { fit: "contain", background: `#${BG}` }).flatten({ background: `#${BG}` }).toBuffer();
  const cap = Buffer.from(`<svg width="${cw}" height="28"><rect width="100%" height="100%" fill="black"/><text x="8" y="20" font-family="monospace" font-size="16" fill="white">${key === "cur" ? "cur (shipped)" : key}</text></svg>`);
  cells.push(await sharp(img).composite([{ input: cap, top: 0, left: 0 }]).png().toBuffer());
}
const cols = results.length;
await sharp({ create: { width: (cw + 6) * cols, height: cw, channels: 3, background: "#888" } })
  .composite(cells.map((c, i) => ({ input: c, left: i * (cw + 6), top: 0 }))).jpeg({ quality: 92 })
  .toFile(join(OUT, `${SKU}_compare.jpg`));
console.log(`sheet → ${OUT}/${SKU}_compare.jpg`);
