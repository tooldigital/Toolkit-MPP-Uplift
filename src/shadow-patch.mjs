// Shadow patching — EXPERIMENTAL module, separate from the production pipeline.
//
// Uses Gemini to improve the Photoroom cast shadow by regenerating ONLY the shadow
// region as a patch, then feather-blending it back into the shadow base. Ported from
// Toolkit-Studio-Next's patch-transfer engine (crop → refine → tone-match → blendPatch),
// with one addition: a product-protection mask (the matte alpha) guarantees product
// pixels are never altered, no matter what Gemini returns.
//
// Flow (per image):
//   1. find the shadow bbox (dark pixels outside the product matte)
//   2. crop it with padding from the shadow base
//   3. Gemini: masked-inpaint style prompt on the crop (temp 0, ≤2K — see src/gemini.mjs
//      for why not 4K), with the full base downscaled as scene context
//   4. tone-match the returned patch using the padding ring (guide's per-channel mean shift)
//   5. feather-blend into the base; blend mask is zeroed wherever matte alpha > 0

import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";

const MODEL = "gemini-3-pro-image-preview";
const LUM = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

export const DEFAULTS = {
  padding: 120,         // px of context around the shadow bbox (guide: AUTO_PADDINGS)
  blendWidth: 48,       // feather ramp at the patch border (shadows are soft → wide)
  shadowThreshold: 238, // luminance below this (outside the matte) counts as shadow — low enough
                        // to skip Photoroom's faint bg gradient; padding catches the pale tail
  alphaIgnore: 8,       // matte alpha above this = product → excluded from bbox + blend
  temperature: 0,
  contextDim: 1024,     // downscaled full base sent as scene context (guide: downscaleB64)
};

export function buildShadowPrompt(cropW, cropH) {
  // Guide's buildAutoPrompt structure: exact-size demand + masked-inpaint hard constraints.
  return `You are retouching a professional product photo.

CRITICAL: Your output image MUST be exactly ${cropW}x${cropH} pixels (width x height) — IMAGE 1's exact framing.

IMAGE 1 (To Fix): a crop of a product's cast shadow on a pure white studio floor. Parts of the product may be visible at the edges of the crop.
IMAGE 2 (Full scene, CONTEXT ONLY): the full product image the crop came from, downscaled. Use it only to understand the product, the light direction, and where the shadow attaches. Do NOT output the full scene.

YOUR TASK: Improve ONLY the cast shadow in IMAGE 1 so it reads like a flawless studio shadow:
- one consistent light direction (keep the direction it already has)
- smooth, even falloff — darkest under the product's contact points, fading softly with distance
- neutral grey throughout: no colour cast, no banding, no noise, no blotches
- keep the shadow's overall footprint, position and DENSITY — refine its quality, do not redesign it

HARD CONSTRAINTS:
- PRESERVE THE SHADOW'S STRENGTH. Do NOT lighten, fade, shrink or remove the shadow. Its darkest
  areas must remain exactly as dark as in IMAGE 1, and it must cover the same area. The shadow is
  intentional — it is NOT dirt or noise to clean up.
- Treat this as a masked inpaint: outside the shadow, output must be pixel-identical to IMAGE 1.
- Any visible product pixels must stay EXACTLY as in IMAGE 1 — never redraw, sharpen or recolour the product.
- The white floor around the shadow stays pure white; the shadow itself stays grey.
- Do not move, rescale, recompose or re-crop anything.`;
}

/** Bbox of shadow pixels: darker than threshold AND not product (matte alpha ~0). */
export function findShadowBbox(baseRGB, alpha, W, H, { shadowThreshold, alphaIgnore } = DEFAULTS) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (alpha[p] > alphaIgnore) continue;
    const i = p * 3;
    if (LUM(baseRGB[i], baseRGB[i + 1], baseRGB[i + 2]) < shadowThreshold) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** One Gemini image-edit call on a crop. Square-pads to 1:1 (white) so the aspect is legal,
 *  requests ≤2K, then un-pads and resizes back to the exact crop size. */
async function geminiRefineCrop({ apiKey, cropPNG, cropW, cropH, contextJPEG, temperature }) {
  const side = Math.max(cropW, cropH);
  const padded = await sharp(cropPNG)
    .extend({
      top: Math.floor((side - cropH) / 2), bottom: Math.ceil((side - cropH) / 2),
      left: Math.floor((side - cropW) / 2), right: Math.ceil((side - cropW) / 2),
      background: "#ffffff",
    })
    .jpeg({ quality: 95 }).toBuffer();

  const parts = [
    { inlineData: { mimeType: "image/jpeg", data: padded.toString("base64") } },
    { inlineData: { mimeType: "image/jpeg", data: contextJPEG.toString("base64") } },
    { text: buildShadowPrompt(cropW, cropH) },
  ];
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts }],
    config: { temperature, imageConfig: { aspectRatio: "1:1", imageSize: side > 1400 ? "2K" : "1K" } },
  });
  const part = (res.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
  if (!part) {
    const text = (res.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("\n");
    throw new Error(`Gemini returned no image. ${text || ""}`);
  }
  const out = Buffer.from(part.inlineData.data, "base64");
  // un-pad: scale the square back to `side`, extract the content region, resize to exact crop dims
  const sq = await sharp(out).resize(side, side, { fit: "fill" })
    .extract({ left: Math.floor((side - cropW) / 2), top: Math.floor((side - cropH) / 2), width: cropW, height: cropH })
    .raw().toBuffer();
  return sq; // raw RGB(A?) — sharp raw from jpeg is 3ch
}

/**
 * Improve the cast shadow of a shadow-base image by patching just the shadow region.
 *
 * @param {object} o
 * @param {string}  o.apiKey       Gemini API key
 * @param {Buffer}  o.shadowBytes  the Photoroom shadow base (product + shadow on white)
 * @param {Buffer}  o.matteBytes   the matte (RGBA; alpha = product) in the SAME frame
 * @param {number} [o.size=4000]   working resolution
 * @param {object} [o.opts]        overrides of DEFAULTS
 * @returns {{ patched: Buffer(raw RGB), bbox, crop: {x1,y1,x2,y2}, before: Buffer(raw RGB) }}
 */
export async function improveShadow({ apiKey, shadowBytes, matteBytes, size = 4000, opts = {} }) {
  const cfg = { ...DEFAULTS, ...opts };
  const W = size, H = size;
  const base = await sharp(shadowBytes).resize(W, H).removeAlpha().raw().toBuffer();
  const alpha = await sharp(matteBytes).resize(W, H).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  // Dilated product mask for DETECTION only: the matte's anti-aliased edge leaves dark
  // near-product pixels with alpha≈0 that would inflate the shadow bbox to the whole
  // silhouette. Blurring the alpha spreads it over that band so those pixels are excluded.
  // Blending below still uses the TIGHT alpha (only true product pixels are protected).
  const blurred = await sharp(alpha, { raw: { width: W, height: H, channels: 1 } }).blur(12).raw().toBuffer();
  // combined mask: blur alone DILUTES isolated faint pixels (fur wisps) below the cutoff,
  // so take max(tight, blurred) — near-product band excluded AND every true alpha pixel kept.
  const nearProduct = Buffer.alloc(W * H);
  for (let p = 0; p < nearProduct.length; p++) nearProduct[p] = Math.max(alpha[p], blurred[p]);

  const bbox = findShadowBbox(base, nearProduct, W, H, cfg);
  if (!bbox) throw new Error("no shadow region found");

  // crop bounds with padding (guide: cropImageB64(..., padding))
  const x1 = Math.max(0, bbox.x0 - cfg.padding), y1 = Math.max(0, bbox.y0 - cfg.padding);
  const x2 = Math.min(W, bbox.x0 + bbox.w + cfg.padding), y2 = Math.min(H, bbox.y0 + bbox.h + cfg.padding);
  const cw = x2 - x1, ch = y2 - y1;

  const cropPNG = await sharp(base, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left: x1, top: y1, width: cw, height: ch }).png().toBuffer();
  const contextJPEG = await sharp(base, { raw: { width: W, height: H, channels: 3 } })
    .resize(cfg.contextDim, cfg.contextDim).jpeg({ quality: 88 }).toBuffer();

  const refined = await geminiRefineCrop({ apiKey, cropPNG, cropW: cw, cropH: ch, contextJPEG, temperature: cfg.temperature });

  // ---- tone-match on the padding ring (guide's per-channel mean shift) ----
  // ring = inside the crop but outside the shadow bbox → should equal the base exactly,
  // so the mean difference there is the patch's global tone drift.
  const fbx0 = bbox.x0 - x1, fby0 = bbox.y0 - y1, fbx1 = fbx0 + bbox.w - 1, fby1 = fby0 + bbox.h - 1;
  let n = 0, sr = 0, sg = 0, sb = 0;
  for (let row = 0; row < ch; row++) for (let col = 0; col < cw; col++) {
    if (col >= fbx0 && col <= fbx1 && row >= fby0 && row <= fby1) continue;
    const pi = (row * cw + col) * 3, bi = ((row + y1) * W + (col + x1)) * 3;
    sr += base[bi] - refined[pi]; sg += base[bi + 1] - refined[pi + 1]; sb += base[bi + 2] - refined[pi + 2];
    n++;
  }
  const dr = n > 64 ? sr / n : 0, dg = n > 64 ? sg / n : 0, db = n > 64 ? sb / n : 0;

  // ---- feather blend into the base, product-protected (guide: blendPatch + featureBox mask) ----
  const out = Buffer.from(base); // copy
  const BW = cfg.blendWidth;
  for (let row = 0; row < ch; row++) for (let col = 0; col < cw; col++) {
    const gx = col + x1, gy = row + y1, gp = gy * W + gx;
    if (alpha[gp] > cfg.alphaIgnore) continue;              // product pixels: never touched
    const edge = Math.min(col, row, cw - 1 - col, ch - 1 - row);
    let m = Math.min(1, edge / BW);                          // feather ramp at crop border
    if (m <= 0) continue;
    const pi = (row * cw + col) * 3, oi = gp * 3;
    out[oi]     = clamp255(out[oi]     * (1 - m) + (refined[pi]     + dr) * m);
    out[oi + 1] = clamp255(out[oi + 1] * (1 - m) + (refined[pi + 1] + dg) * m);
    out[oi + 2] = clamp255(out[oi + 2] * (1 - m) + (refined[pi + 2] + db) * m);
  }

  return { patched: out, before: base, bbox, crop: { x1, y1, x2, y2 }, size: W };
}

// ---------------------------------------------------------------------------
// Mode B — shadow HARVEST. Patch-mode (above) reliably ERASES shadows: given a
// shadow-only crop, the model treats the shadow as dirt to clean, across every
// prompt variant tried. But in FULL-SCENE mode it draws excellent, consistent
// shadows (verified). So: feed it the shadowless product (matte flattened on
// white), let it add lighting + shadow to the whole scene, then keep ONLY the
// shadow (pixels outside the dilated matte) and composite our real product back.
// Shadows are low-frequency, so small registration drift is invisible.
// ---------------------------------------------------------------------------

export const HARVEST_PROMPT = `Add soft studio lighting and ONE soft neutral-grey cast shadow on the floor, falling to the back-right of the product (behind it and to the right). Every part of the product must cast its shadow in this same consistent direction. Keep the product pixel-identical, in the EXACT same position and at the EXACT same scale. The background stays pure flat white.`;

/**
 * Generate a shadow with Gemini (full scene) and harvest it under our real product.
 * @param {object} o
 * @param {string} o.apiKey
 * @param {Buffer} o.matteBytes   matte (RGBA, product + alpha) — the product frame
 * @param {number} [o.size=4000]
 * @param {number} [o.genDim=2048]  Gemini working size (2K; 4K needs temp>0 — see gemini.mjs)
 * @param {number} [o.temperature=0]
 * @returns {{ withShadow: Buffer(raw RGB size²), shadowOnly: Buffer(raw gray size²), gen: Buffer(jpeg) }}
 */
export async function harvestShadow({ apiKey, matteBytes, size = 4000, genDim = 2048, temperature = 0 }) {
  const W = size;
  const productWhite = await sharp(matteBytes).resize(genDim, genDim).flatten({ background: "#fff" })
    .jpeg({ quality: 92 }).toBuffer();

  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/jpeg", data: productWhite.toString("base64") } },
      { text: HARVEST_PROMPT },
    ] }],
    config: { temperature, imageConfig: { aspectRatio: "1:1", imageSize: genDim > 1400 ? "2K" : "1K" } },
  });
  const part = (res.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
  if (!part) throw new Error("Gemini returned no image");
  const gen = Buffer.from(part.inlineData.data, "base64");

  // shadow factor = generated luminance, LOW-PASSED (only the smooth shadow can transfer,
  // never gen texture). No product mask needed: the composite multiplies by (1−a), so under
  // our product sf is irrelevant, and the blur diffuses any thin gen-product drift sliver
  // at the silhouette edge into invisibility.
  const genRGB = await sharp(gen).resize(W, W, { fit: "fill" }).blur(16).removeAlpha().raw().toBuffer();
  const alpha = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();

  const subj = await sharp(matteBytes).resize(W, W).removeAlpha().raw().toBuffer();
  const out = Buffer.alloc(W * W * 3);
  const shadowOnly = Buffer.alloc(W * W, 255);
  for (let p = 0, i = 0; p < W * W; p++, i += 3) {
    const a = alpha[p] / 255;
    const sf = Math.min(1, LUM(genRGB[i], genRGB[i + 1], genRGB[i + 2]) / 255);
    shadowOnly[p] = clamp255(sf * 255);
    const bg = 255 * sf;
    out[i]     = clamp255(subj[i]     * a + bg * (1 - a));
    out[i + 1] = clamp255(subj[i + 1] * a + bg * (1 - a));
    out[i + 2] = clamp255(subj[i + 2] * a + bg * (1 - a));
  }
  return { withShadow: out, shadowOnly, gen, size: W };
}
