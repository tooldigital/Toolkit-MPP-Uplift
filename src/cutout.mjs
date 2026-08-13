import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { logCall } from "./debuglog.mjs";

const ENDPOINT = "https://image-api.photoroom.com/v2/edit";

/**
 * Photoroom background-removal cutout. Returns PNG bytes with transparency.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string|Buffer|Blob} opts.image
 * @param {string} [opts.filename]
 * @param {string} [opts.outputSize="4000x4000"]
 * @param {number} [opts.padding=0]
 * @returns {Promise<Uint8Array>}
 */
export async function cutout(opts) {
  const { apiKey, image, filename, outputSize = "4000x4000", padding = 0, sku } = opts;
  if (!apiKey) throw new Error("apiKey required");
  if (!image) throw new Error("image required");

  const fd = new FormData();
  let blob, name;
  if (typeof image === "string") {
    const buf = await readFile(image);
    blob = new Blob([buf]);
    name = basename(image);
  } else if (image instanceof Blob) {
    blob = image;
    name = filename ?? "image.png";
  } else {
    blob = new Blob([image]);
    name = filename ?? "image.png";
  }
  fd.append("imageFile", blob, name);
  fd.append("removeBackground", "true");
  fd.append("outputSize", outputSize);
  fd.append("padding", String(padding));
  fd.append("export.format", "png");

  return logCall(
    { service: "photoroom", op: "removeBackground", sku },
    { endpoint: ENDPOINT, filename: name, inputBytes: blob.size, fields: { removeBackground: true, outputSize, padding, "export.format": "png" } },
    async () => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "x-api-key": apiKey },
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
