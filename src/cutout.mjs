import { logCall } from "./debuglog.mjs";
import { toBlob } from "./photoroom.mjs";

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
 * @param {boolean} [opts.hd=false]  HD background removal (Plus plan) — crisper edges on ≥2K images.
 * @param {string} [opts.referenceBox]  Photoroom framing: "originalImage" fits the WHOLE input into
 *   the target (minus padding), keeping the subject's original position/scale — the "no-plate" path.
 *   Default (unset = subjectBox) reframes the subject to fill the target.
 * @returns {Promise<Uint8Array>}
 */
export async function cutout(opts) {
  const { apiKey, image, filename, outputSize = "4000x4000", padding = 0, sku, hd = false, referenceBox } = opts;
  if (!apiKey) throw new Error("apiKey required");
  if (!image) throw new Error("image required");

  const fd = new FormData();
  const { blob, name } = await toBlob(image, filename);
  fd.append("imageFile", blob, name);
  fd.append("removeBackground", "true");
  fd.append("outputSize", outputSize);
  fd.append("padding", String(padding));
  if (referenceBox) fd.append("referenceBox", referenceBox);
  fd.append("export.format", "png");

  // HD background removal is a request HEADER (not a form field), Plus plan; crisper subject edges ≥2K.
  const headers = { "x-api-key": apiKey };
  if (hd) headers["pr-hd-background-removal"] = "auto";

  return logCall(
    { service: "photoroom", op: "removeBackground", sku },
    { endpoint: ENDPOINT, filename: name, inputBytes: blob.size, fields: { removeBackground: true, outputSize, padding, referenceBox, "export.format": "png", hd } },
    async () => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers,
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
