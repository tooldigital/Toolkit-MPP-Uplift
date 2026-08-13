// QC: did the uplift TOUCH the product's texture?
//
// Invariant 2 says product pixels come from Photoroom's removeBackground matte (original pixels +
// crisp alpha) and never from Gemini or the soft shadow render. This script tests that claim on
// texture, at native resolution, per SKU.
//
// Registration. The final is NOT pixel-aligned with the source: makePlate crops the subject and
// centres it on the 4000² canvas (scale ≤ 1), then Photoroom re-frames to padding 0.10, which
// upscales the subject to ~3200 px. So we recover the source→final map empirically from the two
// bounding boxes (plate mask bbox vs matte alpha bbox — same product, so uniform scale + offset),
// then lanczos-resample the SOURCE crop by that same factor. Both sides therefore carry one
// comparable resample, and any difference left is something the pipeline did.
//
// Metrics per SKU, on a detail-dense 560² window inside the product (edges excluded — the composite
// legitimately changes those):
//   hp rms src/final  high-pass (grey − blur 6) energy. Final ≥ source ⇒ nothing was smoothed.
//   corr              Pearson correlation of the two high-pass images. ~1 ⇒ same texture, not redrawn.
//   gain              mean final/source ratio in the window = the relight's low-frequency gain.
//   resid             hp rms of (final − gain·source), as % of source hp rms. What is unexplained
//                     by "same pixels × a smooth gain". Small ⇒ texture untouched.
//
// Writes a table to stdout and outputs/qc_<group>_texture.jpg (row 1 source crop, row 2 final crop,
// row 3 amplified difference). Read-only w.r.t. the pipeline.
import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const GROUP = process.argv[process.argv.indexOf("--group") + 1] || "group_sofa";
const FINALS = process.argv.includes("--finals") ? process.argv[process.argv.indexOf("--finals") + 1] : join("outputs/finals", GROUP);
const NP = process.argv.includes("--no-plate") || process.argv.includes("--np");
const HD = process.argv.includes("--hd");
const MATTE = `matte${NP ? "_np" : ""}${HD ? "_hd" : ""}.png`;
const CROP = 560;                                  // window size, final-resolution pixels
const W = 4000;

const bbox = (buf, w, ch, thr = 128) => {
  let x0 = w, x1 = -1, y0 = w, y1 = -1;
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    if (buf[(y * w + x) * ch] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};
const highpass = async (rgbBuf, n) => {                       // grey − blur(6), as Float32, mean-removed
  const g = await sharp(rgbBuf, { raw: { width: n, height: n, channels: 3 } }).greyscale().raw().toBuffer();
  const b = await sharp(rgbBuf, { raw: { width: n, height: n, channels: 3 } }).greyscale().blur(6).raw().toBuffer();
  const hp = new Float32Array(n * n);
  let m = 0;
  for (let i = 0; i < n * n; i++) { hp[i] = g[i] - b[i]; m += hp[i]; }
  m /= n * n;
  for (let i = 0; i < n * n; i++) hp[i] -= m;
  return { hp, grey: g };
};
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

const skus = (await readdir(join("inputs", GROUP))).filter(f => f.endsWith(".jpg")).map(f => f.replace(".jpg", "")).sort();
const rows = [];

for (const sku of skus) {
  const source = join("inputs", GROUP, `${sku}.jpg`);
  const finalP = join(FINALS, `${sku}.jpg`);
  const matteP = join("outputs/work", sku, MATTE);
  if (!existsSync(finalP) || !existsSync(matteP)) { console.log(`skip ${sku}`); continue; }

  // --- source→final registration, path-agnostic: the product's own bbox in the SOURCE vs in the
  //     matte gives scale + offset directly, so this works for the standard plate path and for
  //     --no-plate (referenceBox=originalImage) alike, with no assumption about how it was framed.
  const smeta = await sharp(source).metadata();
  const sraw = await sharp(source).removeAlpha().raw().toBuffer();
  const lumAt = (x, y) => { const i = (y * smeta.width + x) * 3; return 0.2126 * sraw[i] + 0.7152 * sraw[i + 1] + 0.0722 * sraw[i + 2]; };
  // Several of these studio shots sit on a soft GRAY backdrop, not white, so a fixed L<245 subject
  // threshold swallows the whole frame. Estimate the backdrop from the four corners instead.
  const corners = [];
  for (const [cx0, cy0] of [[0, 0], [smeta.width - 40, 0], [0, smeta.height - 40], [smeta.width - 40, smeta.height - 40]]) {
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) corners.push(lumAt(cx0 + x, cy0 + y));
  }
  corners.sort((a, b) => a - b);
  const bgLum = corners[Math.floor(corners.length / 2)];
  const thr = Math.min(245, bgLum - 8);
  let sx0 = smeta.width, sx1 = -1, sy0 = smeta.height, sy1 = -1;
  for (let y = 0; y < smeta.height; y++) for (let x = 0; x < smeta.width; x++) {
    if (lumAt(x, y) < thr) { if (x < sx0) sx0 = x; if (x > sx1) sx1 = x; if (y < sy0) sy0 = y; if (y > sy1) sy1 = y; }
  }
  const sb = { x0: sx0, y0: sy0, w: sx1 - sx0 + 1, h: sy1 - sy0 + 1 };
  const am = await sharp(matteP).extractChannel(3).raw().toBuffer();
  const ab = bbox(am, W, 1);
  const totalScale = ((ab.w / sb.w) + (ab.h / sb.h)) / 2;     // source px → final px
  const s = totalScale;

  // --- pick a detail-dense window inside the product (erode the alpha so edges are excluded)
  // (sharp promotes a 1-channel raw input to sRGB on blur, so read the real stride back)
  const er = await sharp(am, { raw: { width: W, height: W, channels: 1 } })
    .blur(14).raw().toBuffer({ resolveWithObject: true });     // blur+threshold ≈ erode by ~20 px
  const eroded = er.data, ec = er.info.channels;
  const D = 200, step = W / D;                                // coarse detail map
  const small = await sharp(finalP).resize(D, D, { fit: "fill" }).greyscale().raw().toBuffer();
  const smallBlur = await sharp(finalP).resize(D, D, { fit: "fill" }).greyscale().blur(2).raw().toBuffer();
  let bestDetail = -1, bx = 0, by = 0;
  const half = CROP / 2;
  for (let y = 1; y < D - 1; y++) for (let x = 1; x < D - 1; x++) {
    const fx = Math.round(x * step), fy = Math.round(y * step);
    if (fx < half || fy < half || fx > W - half || fy > W - half) continue;
    // window must be fully inside the eroded product
    let inside = true;
    for (const [ox, oy] of [[-half, -half], [half, -half], [-half, half], [half, half], [0, 0]]) {
      if (eroded[((fy + oy) * W + (fx + ox)) * ec] < 250) { inside = false; break; }
    }
    if (!inside) continue;
    const e = Math.abs(small[y * D + x] - smallBlur[y * D + x]);
    if (e > bestDetail) { bestDetail = e; bx = fx; by = fy; }
  }
  if (bestDetail < 0) { console.log(`skip ${sku} (no interior window fits ${CROP}\u00b2)`); continue; }

  // --- crops: final at native res, source resampled by totalScale so both carry one resample
  const finalCrop = await sharp(finalP)
    .extract({ left: bx - half, top: by - half, width: CROP, height: CROP }).removeAlpha().raw().toBuffer();
  // map window centre back to source coords: canvas = scale*(src - srcBbox) + place, then Photoroom
  const srcX = (bx - ab.x0) / totalScale + sb.x0, srcY = (by - ab.y0) / totalScale + sb.y0;
  // The bbox-derived map is only good to a few pixels, and at these frequencies a 2 px error alone
  // drives the correlation to ~0. So resample a PADDED source region and search (scale, dx, dy) for
  // the true alignment; the recovered offset is itself reported, as a check that it stayed small.
  const R = 24;                                              // search radius, final px
  const PAD = CROP + 2 * R;
  const meta = smeta;
  const best = { corr: -2 };
  for (const ds of [0.985, 0.99, 0.995, 1, 1.005, 1.01, 1.015]) {
    const ts = totalScale * ds;
    const side = Math.round(PAD / ts);
    const l = Math.round(srcX - side / 2), t = Math.round(srcY - side / 2);
    if (l < 0 || t < 0 || l + side > meta.width || t + side > meta.height) continue;
    const padCrop = await sharp(source)
      .extract({ left: l, top: t, width: side, height: side })
      .resize(PAD, PAD, { fit: "fill", kernel: "lanczos3" }).removeAlpha().raw().toBuffer();
    const P = await highpass(padCrop, PAD);
    const Fh = (await highpass(finalCrop, CROP)).hp;
    // coarse-to-fine offset search on a 256² central sub-window
    const N = 256, o0 = (CROP - N) / 2;
    const score = (dx, dy) => {
      let dot = 0, sa = 0, sb = 0;
      for (let y = 0; y < N; y++) {
        const fi = (y + o0) * CROP + o0, pi = (y + o0 + R + dy) * PAD + (o0 + R + dx);
        for (let x = 0; x < N; x++) { const a = Fh[fi + x], b = P.hp[pi + x]; dot += a * b; sa += a * a; sb += b * b; }
      }
      return dot / Math.sqrt(sa * sb);
    };
    let loc = { c: -2, dx: 0, dy: 0 };
    for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
      const c = score(dx, dy); if (c > loc.c) loc = { c, dx, dy };
    }
    for (let dy = loc.dy - 1; dy <= loc.dy + 1; dy++) for (let dx = loc.dx - 1; dx <= loc.dx + 1; dx++) {
      if (Math.abs(dx) > R || Math.abs(dy) > R) continue;
      const c = score(dx, dy); if (c > loc.c) loc = { c, dx, dy };
    }
    if (loc.c > best.corr) Object.assign(best, { corr: loc.c, dx: loc.dx, dy: loc.dy, ds, padCrop });
  }
  if (best.corr < -1) { console.log(`skip ${sku} (alignment failed)`); continue; }

  // aligned source crop at the winning (scale, dx, dy)
  const srcCrop = Buffer.alloc(CROP * CROP * 3);
  for (let y = 0; y < CROP; y++) {
    const from = ((y + R + best.dy) * PAD + (R + best.dx)) * 3;
    best.padCrop.copy(srcCrop, y * CROP * 3, from, from + CROP * 3);
  }

  // --- metrics, at the recovered alignment
  const F = await highpass(finalCrop, CROP), S = await highpass(srcCrop, CROP);
  const rf = rms(F.hp), rs = rms(S.hp);
  let dot = 0;
  for (let i = 0; i < F.hp.length; i++) dot += F.hp[i] * S.hp[i];
  const corr = dot / (F.hp.length * rf * rs);
  let gs = 0, gn = 0;
  for (let i = 0; i < F.grey.length; i++) if (S.grey[i] > 8) { gs += F.grey[i] / S.grey[i]; gn++; }
  const gain = gs / gn;
  // least-squares amplitude of source hp inside final hp — how much of the final IS the source
  let num = 0, den = 0;
  for (let i = 0; i < F.hp.length; i++) { num += F.hp[i] * S.hp[i]; den += S.hp[i] * S.hp[i]; }
  const beta = num / den;
  const resid = new Float32Array(F.hp.length);
  for (let i = 0; i < resid.length; i++) resid[i] = F.hp[i] - beta * S.hp[i];
  const residPct = (rms(resid) / rf) * 100;
  const sd = Math.round(PAD / (totalScale * best.ds));

  // --- diff visual: (final − source) amplified around mid grey
  const diff = Buffer.alloc(CROP * CROP * 3);
  for (let i = 0; i < CROP * CROP * 3; i++) diff[i] = Math.max(0, Math.min(255, 128 + (finalCrop[i] - srcCrop[i]) * 4));

  rows.push({ sku, bgLum, thr, srcCrop, finalCrop, diff, srcSide: sd, totalScale, prScale: s, plateScale: 1, rf, rs, corr, gain, beta, residPct, align: best, at: [bx, by] });
  console.log(`${sku} ok  bg${Math.round(bgLum)} thr${Math.round(thr)}  ${sd}\u00b2src \u2192 ${CROP}\u00b2final (\u00d7${totalScale.toFixed(2)})  align dx${best.dx} dy${best.dy} s\u00d7${best.ds}  corr ${corr.toFixed(3)}`);
}

// ---------- table ----------
const f = (v, d = 3) => v.toFixed(d).padStart(7);
console.log(`\n=== ${GROUP}: texture preservation, ${CROP}² native-res window per SKU ===\n`);
console.log("SKU         │  n/a   PR×  total× │ align dx  dy   s×   │ hp rms src  final  ratio │  corr   beta   gain  resid%");
console.log("────────────┼────────────────────┼──────────────────────────┼─────────────────────");
for (const r of rows) {
  console.log(`${r.sku.padEnd(11)} │ ${f(r.plateScale, 2)} ${f(r.prScale, 2)} ${f(r.totalScale, 2)} │ ` +
    `${String(r.align.dx).padStart(4)} ${String(r.align.dy).padStart(4)} ${f(r.align.ds, 3)} │ ` +
    `${f(r.rs, 2)} ${f(r.rf, 2)} ${f(r.rf / r.rs, 2)} │ ${f(r.corr)} ${f(r.beta, 3)} ${f(r.gain, 3)} ${f(r.residPct, 1)}`);
}
const stat = (g) => { const v = rows.map(g); const m = v.reduce((a, b) => a + b, 0) / v.length; return { m, sd: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length), min: Math.min(...v), max: Math.max(...v) }; };
for (const [label, g, u] of [["high-pass corr", r => r.corr, ""], ["detail ratio final/src", r => r.rf / r.rs, "×"], ["relight gain", r => r.gain, "×"], ["unexplained residual", r => r.residPct, "%"], ["alignment shift px", r => Math.hypot(r.align.dx, r.align.dy), "px"]]) {
  const s = stat(g);
  console.log(`\n${label.padEnd(24)} mean ${s.m.toFixed(3)}${u}  sd ${s.sd.toFixed(3)}  range ${s.min.toFixed(3)} … ${s.max.toFixed(3)}`);
}

// ---------- sheet ----------
const T = CROP, LBL = 26;
const comps = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const put = async (buf, row) => comps.push({
    input: await sharp(buf, { raw: { width: CROP, height: CROP, channels: 3 } }).png().toBuffer(),
    left: i * T, top: row * (T + LBL) + LBL,
  });
  await put(r.srcCrop, 0); await put(r.finalCrop, 1); await put(r.diff, 2);
  const labels = [
    `${r.sku}  SOURCE ×${r.totalScale.toFixed(2)}`,
    `FINAL  detail ${(r.rf / r.rs).toFixed(2)}× src`,
    `DIFF ×4  corr ${r.corr.toFixed(3)}  resid ${r.residPct.toFixed(0)}%`,
  ];
  labels.forEach((text, row) => comps.push({
    input: Buffer.from(`<svg width="${T}" height="${LBL}"><rect width="${T}" height="${LBL}" fill="#111"/><text x="7" y="18" font-size="15" font-family="monospace" fill="#eee">${text}</text></svg>`),
    left: i * T, top: row * (T + LBL),
  }));
}
const out = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : `outputs/qc_${GROUP}_texture.jpg`;
await sharp({ create: { width: rows.length * T, height: 3 * (T + LBL), channels: 3, background: "#fff" } })
  .composite(comps).jpeg({ quality: 95 }).toFile(out);
console.log(`\nsheet → ${out}  (row 1 = source crop, row 2 = final crop, row 3 = difference ×4)`);
