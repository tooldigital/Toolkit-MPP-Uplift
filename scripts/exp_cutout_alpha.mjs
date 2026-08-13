// EXPERIMENT — pass the CUTOUT to Gemini WITH ITS ALPHA (transparent PNG), instead of flattened
// on a background, and see whether it cleans the white fringe / how it handles transparency.
// Writes only to outputs/experiments/cutout_bg/ (alongside the bg sweep).
//
//   node --env-file=.env scripts/exp_cutout_alpha.mjs PE964848 [sku...]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { DEFAULT_MODEL, IMAGE_SIZE, ASPECT_RATIO } from "../src/gemini.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (skus.length === 0) { console.error("usage: exp_cutout_alpha.mjs <sku> [sku...]"); process.exit(1); }

const W = 4000;
const OUT = "outputs/experiments/cutout_bg";
await mkdir(OUT, { recursive: true });
const exists = (p) => readFile(p).then(() => true, () => false);
function bbox(a, W, H, thr = 40) { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }

const INSTRUCTION = `This is a product cutout on a TRANSPARENT background (PNG alpha). Around the fuzzy fur silhouette there is a thin bright WHITE matting fringe left by imperfect background removal.

Remove ONLY that white fringe: recolor those edge pixels to match the adjacent fur color so the silhouette reads as clean fur against the empty background.

- Keep the product body, its fur texture and color, pixel-for-pixel — do NOT restyle or invent detail.
- Keep the background empty/transparent (or pure white). Add NO shadow.
- Do NOT move, rescale, re-crop or recompose. Product stays in the EXACT same position and scale.`;

// Direct Gemini call that preserves the PNG alpha (does NOT flatten to white like generateShadowGemini).
async function geminiAlpha(pngBytes) {
  const ai = new GoogleGenAI({ apiKey: K });
  const resp = await ai.models.generateContent({
    model: DEFAULT_MODEL,
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: Buffer.from(pngBytes).toString("base64") } },
      { text: INSTRUCTION },
    ] }],
    config: { temperature: 0, imageConfig: { aspectRatio: ASPECT_RATIO, imageSize: IMAGE_SIZE } },
  });
  for (const p of resp.candidates?.[0]?.content?.parts ?? []) if (p.inlineData?.data) return Buffer.from(p.inlineData.data, "base64");
  throw new Error("no image from gemini");
}

for (const sku of skus) {
  process.stdout.write(`${sku} (alpha) ... `);
  try {
    const dir = `outputs/work/${sku}`;
    const matteBytes = await readFile(join(dir, "matte.png"));
    // 2K PNG WITH alpha preserved (match Gemini's working res; alpha channel intact).
    const alphaPng = await sharp(matteBytes).resize(2048, 2048, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();

    const rawPath = join(OUT, `${sku}_alphaIN_raw.png`);
    let raw;
    if (await exists(rawPath)) raw = await readFile(rawPath);
    else { raw = await geminiAlpha(alphaPng); await writeFile(rawPath, raw); }

    // Report what Gemini returned: dimensions + whether it has an alpha channel.
    const meta = await sharp(raw).metadata();
    const hasAlpha = meta.hasAlpha;
    const gem = await sharp(raw).resize(W, W, { fit: "fill" }).png().toBuffer();

    // Reveal the edge on dark gray (fringe shows there). If Gemini returned alpha, flatten over gray;
    // if opaque, just show it. Compare against the matte on the same gray.
    const A = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const bb = bbox(A, W, W, 40);
    const cw = 1300, ch = 560;
    const ex = { left: Math.min(Math.max(0, (bb.x0 * 2 + bb.w) / 2 - cw / 2), W - cw) | 0,
                 top:  Math.min(Math.max(0, bb.y0 + bb.h - ch + 150), W - ch) | 0, width: cw, height: ch };
    const onGray = (buf) => sharp(buf).flatten({ background: "#2A2A2A" }).toBuffer();
    const matteGray = await onGray(await sharp(matteBytes).resize(W, W).png().toBuffer());
    const gemGray = await onGray(gem);

    const cwp = 640, panels = [];
    for (const [lbl, buf] of [["matte on gray (input)", matteGray], ["gemini(alpha) on gray", gemGray]]) {
      const im = await sharp(await sharp(buf).extract(ex).toBuffer()).resize(cwp, null).png().toBuffer();
      const h = (await sharp(im).metadata()).height;
      const cap = Buffer.from(`<svg width="${cwp}" height="20"><rect width="100%" height="100%" fill="black"/><text x="6" y="15" font-family="monospace" font-size="13" fill="white">${lbl}</text></svg>`);
      panels.push(await sharp({ create: { width: cwp, height: h + 20, channels: 3, background: "#000" } }).composite([{ input: im, top: 20, left: 0 }, { input: cap, top: 0, left: 0 }]).png().toBuffer());
    }
    // full output thumbnail over gray for artifact check
    const full = await sharp(gemGray).resize(cwp, cwp, { fit: "contain", background: "#2A2A2A" }).png().toBuffer();
    const capf = Buffer.from(`<svg width="${cwp}" height="20"><rect width="100%" height="100%" fill="black"/><text x="6" y="15" font-family="monospace" font-size="13" fill="white">full (gemini alpha? ${hasAlpha}) ${meta.width}x${meta.height}</text></svg>`);
    panels.push(await sharp({ create: { width: cwp, height: cwp + 20, channels: 3, background: "#000" } }).composite([{ input: full, top: 20, left: 0 }, { input: capf, top: 0, left: 0 }]).png().toBuffer());

    const ph = Math.max(...await Promise.all(panels.map(async (p) => (await sharp(p).metadata()).height)));
    await sharp({ create: { width: (cwp + 6) * panels.length, height: ph, channels: 3, background: "#222" } })
      .composite(panels.map((p, i) => ({ input: p, left: i * (cwp + 6), top: 0 }))).jpeg({ quality: 93 }).toFile(join(OUT, `${sku}_alpha_test.jpg`));
    console.log(`ok  (returned alpha=${hasAlpha}, ${meta.width}x${meta.height}) → ${OUT}/${sku}_alpha_test.jpg`);
  } catch (e) {
    console.log("FAIL: " + e.message);
  }
}
