import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { logCall } from "./debuglog.mjs";

const ENDPOINT = "https://image-api.photoroom.com/v2/edit";
const MODEL_VERSION = "2026-04-15";

/** File path, Buffer or Blob → { blob, name } for a multipart upload. Shared by both Photoroom calls. */
export async function toBlob(image, filename) {
  if (typeof image === "string") return { blob: new Blob([await readFile(image)]), name: basename(image) };
  if (image instanceof Blob) return { blob: image, name: filename ?? "image.png" };
  return { blob: new Blob([image]), name: filename ?? "image.png" };
}

/**
 * Generate a shadow on an image via Photoroom v2/edit.
 *
 * @param {object} opts
 * @param {string} opts.apiKey                Photoroom API key (sandbox_ prefix for sandbox).
 * @param {string|Buffer|Blob} opts.image     File path, Buffer, or Blob/File.
 * @param {string} [opts.filename]            Filename hint when image is Buffer/Blob.
 * @param {object} [opts.shadow]              Shadow params (see below).
 * @param {string} [opts.shadow.mode="ai.auto-with-overrides"]
 * @param {number} [opts.shadow.softness]     0–1
 * @param {number} [opts.shadow.intensity]    0–1
 * @param {string|number} [opts.shadow.spread]    short|medium|long or 0–90
 * @param {string|number} [opts.shadow.direction] behind|behindLeft|left|frontLeft|front|frontRight|right|behindRight or 0–360
 * @param {string|number} [opts.shadow.subjectPose] flatlay|upright or 0–90
 * @param {string} [opts.background="FFFFFF"] Background color hex (no #).
 * @param {string} [opts.outputSize]          e.g. "2000x2000"
 * @param {number} [opts.padding]             0–1
 * @param {"png"|"jpeg"|"webp"} [opts.format] Export format (default png).
 * @returns {Promise<Uint8Array>} Image bytes.
 */
export async function generateShadow(opts) {
  const {
    apiKey,
    image,
    filename,
    shadow = {},
    background = "FFFFFF",
    outputSize,
    padding,
    format,
    sku,
    referenceBox,
  } = opts;

  if (!apiKey) throw new Error("apiKey required");
  if (!image) throw new Error("image required");

  const fd = new FormData();

  const { blob, name } = await toBlob(image, filename);
  fd.append("imageFile", blob, name);

  fd.append("shadow.mode", shadow.mode ?? "ai.auto-with-overrides");
  if (shadow.softness != null) fd.append("shadow.softnessOverride", String(shadow.softness));
  if (shadow.intensity != null) fd.append("shadow.intensityOverride", String(shadow.intensity));
  if (shadow.spread != null) fd.append("shadow.spreadOverride", String(shadow.spread));
  if (shadow.direction != null) fd.append("shadow.directionOverride", String(shadow.direction));
  if (shadow.subjectPose != null) fd.append("shadow.subjectPoseOverride", String(shadow.subjectPose));

  fd.append("background.color", background);
  if (outputSize) fd.append("outputSize", outputSize);
  if (padding != null) fd.append("padding", String(padding));
  if (referenceBox) fd.append("referenceBox", referenceBox);
  if (format) fd.append("export.format", format);

  return logCall(
    { service: "photoroom", op: "generateShadow", sku },
    { endpoint: ENDPOINT, filename: name, inputBytes: blob.size, modelVersion: MODEL_VERSION, fields: { shadow, background, outputSize, padding, referenceBox, "export.format": format } },
    async () => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "pr-ai-shadows-model-version": MODEL_VERSION,
        },
        body: fd,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Photoroom ${res.status}: ${text || res.statusText}`);
      }

      return new Uint8Array(await res.arrayBuffer());
    },
  );
}
