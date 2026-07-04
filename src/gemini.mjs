import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";

export const DEFAULT_MODEL = "gemini-3-pro-image-preview";
export const ASPECT_RATIO = "1:1";
// IMPORTANT: at temperature 0, large flat-white regions degenerate into repeating
// checkerboard/tile artifacts — greedy sampling locks into a loop. It manifests at 4K
// (4× the flat area) and not at 2K. Verified A/B: 4K+temp0 tiles, 4K+temp0.7 is clean,
// 2K+temp0 is clean. We need temp 0 (deterministic lightmap), so we use 2K. The relight
// is consumed as a LOW-FREQUENCY lighting map only — the runner upscales + low-passes it —
// so 2K loses nothing. If you raise this to 4K you must also raise the temperature.
export const IMAGE_SIZE = "2K"; // 1K | 2K | 4K — uppercase K required
export const PREPROCESS = {
  maxDim: 2048,            // match the 2K output request
  fit: "contain",          // letterbox to square (preserve subject)
  padColor: "#FFFFFF",     // white padding for letterbox
  jpegQuality: 92,
};
const MAX_DIM = PREPROCESS.maxDim;

export const INSTRUCTION = `Apply lighting and shadow to the product in the first image, matching the reference (second image).

- Soft front-left key light. Do not over-light — preserve the product's original contrast, blacks, and highlights.
- Soft, subtle shadow falling off to the right. Neutral grey, equal density across; no color picked up from the product.
- Keep the product in the EXACT same position and at the EXACT same scale as the input. Do not re-center, re-crop, or resize it. White background.
- Keep the product pixel-for-pixel: textures, logos, seams, weave intact.`;

export const INSTRUCTION_RELIGHT = `The image shows a product with a soft cast shadow on a white background.

Apply lighting to the PRODUCT only:
- Soft front-left key light, slightly above the product.
- Mild ambient fill so the right side of the product is darker than the left but still readable.
- Preserve the product's contrast, color, and material.

DO NOT modify the cast shadow on the ground. DO NOT modify the white background. The shadow must stay exactly as it is in the input — same shape, same position, same opacity, same colour.

Keep the product in the EXACT same position and at the EXACT same scale as the input.`;

// Lighting-intensity variants for the relight stage. All preserve the existing
// shadow + background; only the strength of the directional key light differs.
// Input is the Photoroom shadow base: the product WITH its soft cast shadow on white.
// The prompt matches that — relight the product, keep the shadow and white background.
export const RELIGHT_VARIANTS = {
  subtle: `The image shows a product with a soft cast shadow on a white background.

Apply VERY GENTLE lighting to the PRODUCT only:
- Subtle front-left key light. Almost flat — only a hint of directional shading.
- High ambient fill so the right side of the product remains nearly as bright as the left.
- Preserve the product's contrast, color, and material — do not deepen any shadows on it.

DO NOT modify the cast shadow on the ground. DO NOT modify the white background. The shadow must stay exactly as it is in the input — same shape, same position, same opacity, same colour.

Keep the product in the EXACT same position and at the EXACT same scale as the input.`,

  standard: `The image shows a product with a soft cast shadow on a white background.

Apply lighting to the PRODUCT only:
- Soft front-left key light, slightly above the product.
- Mild ambient fill so the right side of the product is darker than the left but still readable.
- Preserve the product's contrast, color, and material.

DO NOT modify the cast shadow on the ground. DO NOT modify the white background. The shadow must stay exactly as it is in the input — same shape, same position, same opacity, same colour.

Keep the product in the EXACT same position and at the EXACT same scale as the input.`,

  strong: `The image shows a product with a soft cast shadow on a white background.

Apply PRONOUNCED directional lighting to the PRODUCT only:
- Bright front-left key light, slightly above the product. Clearly visible falloff across the product.
- Low ambient fill so the right side of the product is noticeably darker than the left, with deeper self-shadowing on the right-facing surfaces.
- Brighten the highlights on the left-facing surfaces. Keep colors saturated; do not crush the blacks.

DO NOT modify the cast shadow on the ground. DO NOT modify the white background. The shadow must stay exactly as it is in the input — same shape, same position, same opacity, same colour.

Keep the product in the EXACT same position and at the EXACT same scale as the input.`,
};

/**
 * Apply a fixed lighting + shadow look to a product image using a reference image.
 *
 * @param {object} opts
 * @param {string} opts.apiKey                  Gemini API key.
 * @param {string|Buffer|Blob} opts.image       Product image — file path, Buffer, or Blob.
 * @param {string|Buffer|Blob} opts.reference   Reference image showing the target light/shadow.
 * @param {string} [opts.filename]              Filename hint when image is Buffer/Blob.
 * @param {string} [opts.instruction]           Override the default instruction text.
 * @param {string} [opts.model]                 Default: gemini-3-pro-image-preview.
 * @returns {Promise<Uint8Array>} Image bytes.
 */
export async function generateShadowGemini(opts) {
  const {
    apiKey,
    image,
    reference,
    filename,
    instruction = INSTRUCTION,
    model = DEFAULT_MODEL,
    temperature = 0.2,
  } = opts;

  if (!apiKey) throw new Error("apiKey required");
  if (!image) throw new Error("image required");

  const subject = await loadImagePart(image, filename ?? "subject.png");
  const parts = [{ inlineData: subject }];
  if (reference) {
    const ref = await loadImagePart(reference, "reference.png");
    parts.push({ inlineData: ref });
  }
  parts.push({ text: instruction });

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: {
      temperature,
      imageConfig: { aspectRatio: ASPECT_RATIO, imageSize: IMAGE_SIZE },
    },
  });

  const respParts = response.candidates?.[0]?.content?.parts ?? [];
  for (const p of respParts) {
    if (p.inlineData?.data) {
      return new Uint8Array(Buffer.from(p.inlineData.data, "base64"));
    }
  }
  const text = respParts.map((p) => p.text).filter(Boolean).join("\n");
  throw new Error(`Gemini returned no image. Text: ${text || "(empty)"}`);
}

async function loadImagePart(image, fallbackName) {
  let buf;
  if (typeof image === "string") {
    buf = await readFile(image);
  } else if (image instanceof Blob) {
    buf = Buffer.from(await image.arrayBuffer());
  } else {
    buf = Buffer.from(image);
  }
  // Pad to exact square on white so subject and reference share identical aspect.
  const out = await sharp(buf)
    .rotate()
    .resize({
      width: MAX_DIM,
      height: MAX_DIM,
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .jpeg({ quality: 92 })
    .toBuffer();
  return { mimeType: "image/jpeg", data: out.toString("base64") };
}
