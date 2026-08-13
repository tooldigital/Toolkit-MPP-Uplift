// Step 1 — Canonical plate.
//
// Place a product (clean-white IKEA original) ONCE on a fixed square canvas at a
// known scale and position, over a configurable background, and record the exact
// transform. Every downstream layer (mask, shadow, relight) is produced in THIS
// frame, so they register by construction — no realign step.
//
// Returns { plate, mask, transform }:
//   plate     PNG bytes — subject placed over `bg`, frame×frame
//   mask      PNG bytes — 8-bit alpha matte of the subject, in plate coords
//   transform the placement record (so any source-space point maps to canvas)

import sharp from "sharp";

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

// Subject bounding box on a clean white background: pixels darker than threshold.
function detectBbox(data, W, H, channels, threshold) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * channels;
      if (lum(data[i], data[i + 1], data[i + 2]) < threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("no subject detected (image fully white?)");
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * @param {object} opts
 * @param {string|Buffer} opts.source     clean-white product image
 * @param {number} [opts.frame=4000]      output canvas size
 * @param {number} [opts.maxSubject=3200] longest subject side after scaling (400px margin in 4000)
 * @param {string} [opts.bg="FFFFFF"]     background hex
 * @param {number} [opts.threshold=245]   luminance cutoff for subject vs white
 * @param {number} [opts.edgeSoftness=6]  px ramp for the mask alpha edge (anti-alias)
 */
export async function makePlate({
  source, frame = 4000, maxSubject = 3200, threshold = 245, edgeSoftness = 6,
} = {}) {
  // 1. Load source, find the subject bbox.
  const src = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: SW, height: SH, channels } = src.info;
  const bb = detectBbox(src.data, SW, SH, channels, threshold);
  const cw = bb.x1 - bb.x0, ch = bb.y1 - bb.y0;

  // 2. Uniform scale so the longer side fits maxSubject (only ever scale DOWN).
  const scale = Math.min(1, maxSubject / Math.max(cw, ch));
  const newW = Math.round(cw * scale), newH = Math.round(ch * scale);

  // 3. Crop to subject, scale uniformly (lanczos).
  const cropScaled = await sharp(source)
    .extract({ left: bb.x0, top: bb.y0, width: cw, height: ch })
    .resize(newW, newH, { fit: "fill", kernel: "lanczos3" })
    .removeAlpha()
    .raw()
    .toBuffer();

  // 4. Mask from the SAME scaled crop → identical size/position → registered.
  //    Soft alpha: ramp over [threshold-edgeSoftness, threshold].
  const maskRaw = Buffer.alloc(newW * newH);
  for (let p = 0, i = 0; p < maskRaw.length; p++, i += 3) {
    const L = lum(cropScaled[i], cropScaled[i + 1], cropScaled[i + 2]);
    const a = (threshold - L) / edgeSoftness;
    maskRaw[p] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
  }

  // 5. Place at the canonical offset. The plate is the CUT-OUT product on a
  //    transparent canvas (RGBA) — registered geometry only. Keeping the product
  //    transparent (not pasting the original's white rectangle) is what lets the
  //    background be chosen later (Step 5) and lets us discard the original's
  //    baked floor/shadow and cast our own neutral one.
  const cx = Math.round((frame - newW) / 2);
  const cy = Math.round((frame - newH) / 2);

  // RGBA subject = scaled crop + mask as alpha.
  const subjectRGBA = await sharp(cropScaled, { raw: { width: newW, height: newH, channels: 3 } })
    .joinChannel(maskRaw, { raw: { width: newW, height: newH, channels: 1 } })
    .png()
    .toBuffer();
  const plate = await sharp({
    create: { width: frame, height: frame, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: subjectRGBA, left: cx, top: cy }])
    .png()
    .toBuffer();

  // Full-frame mask (1-channel), same offset → co-registered with the plate.
  const maskFull = Buffer.alloc(frame * frame, 0);
  for (let y = 0; y < newH; y++) {
    maskRaw.copy(maskFull, (cy + y) * frame + cx, y * newW, (y + 1) * newW);
  }
  const mask = await sharp(maskFull, { raw: { width: frame, height: frame, channels: 1 } }).png().toBuffer();

  // 6. The transform: source_xy → canvas_xy = scale*(source_xy - bboxOrigin) + place.
  const transform = {
    frame, maxSubject, threshold,
    srcSize: { w: SW, h: SH },
    srcBbox: bb,
    subject: { w: newW, h: newH, scale },
    place: { left: cx, top: cy },
    map: "canvas_xy = scale*(source_xy - [srcBbox.x0, srcBbox.y0]) + [place.left, place.top]",
    margins: { left: cx, top: cy, right: frame - newW - cx, bottom: frame - newH - cy },
  };

  return { plate, mask, transform };
}

/**
 * Square plate WITHOUT luminance bbox detection — for transparent/bright products (glass).
 * makePlate() finds the subject by luminance (< threshold), which crops off bright glass
 * edges/clips (they read as background) and truncates the product. Here we skip detection
 * entirely: the whole source is `contain`-fit onto a frame×frame canvas over `bg`, and
 * Photoroom (real subject detection, padding:0.10) does the reframing downstream.
 * @param {string|Buffer} source  clean-white product image (any size/aspect)
 * @param {number} [frame=4000]    output square size
 * @param {string} [bg="FFFFFF"]   background hex
 */
export async function squarePlate(source, frame = 4000, bg = "FFFFFF") {
  const { r, g, b } = hexToRgb(bg);
  return sharp(source)
    .resize(frame, frame, { fit: "contain", background: { r, g, b }, kernel: "lanczos3" })
    .flatten({ background: { r, g, b } })
    .png()
    .toBuffer();
}

/**
 * Flatten a transparent plate (RGBA product) onto a solid background color.
 * This is the Step-5 background choice in isolation (no shadow) — used for the
 * no-shadow white output and for previewing white/gray/dark backdrops.
 * @param {Buffer} plate  RGBA PNG from makePlate
 * @param {string} bg     background hex
 */
export async function composeBackground(plate, bg = "FFFFFF") {
  const { r, g, b } = hexToRgb(bg);
  return sharp(plate).flatten({ background: { r, g, b } }).png().toBuffer();
}
