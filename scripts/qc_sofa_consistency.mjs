// QC: is the uplift CONSISTENT across a whole product category?
//
// Reads the cached stages for every SKU in a group (outputs/work/<sku>/{matte.png,relit.jpg,shadow.jpg})
// and measures the two things a category page has to agree on:
//
//   LIGHTING — the relight actually applied is  f = 1 + ((lm - mean)/128) * strength,
//              lm = luma(blur(relit)) (run_pipeline.mjs). We recompute lm over the PRODUCT pixels
//              (matte alpha > 0.5) and report the gradient as a % brightness delta across the
//              product plus its direction (0° = brighter on the left, 90° = brighter at the top).
//              Front-left key light ⇒ every SKU should sit in the upper-left quadrant.
//
//   SHADOW  — mask = shadow render darker than 245 where the product is absent (alpha < 0.05).
//             Reported as the shadow centroid offset from the product's bottom-centre, normalised by
//             product width, plus its direction and how far it reaches. A consistent set = tight
//             spread on direction + reach, not identical numbers (shapes differ per sofa).
//
// Writes a metrics table to stdout and a visual proof sheet (shadow masks + lighting maps).
// Read-only w.r.t. the pipeline: touches nothing outside outputs/qc_<group>*.
import sharp from "sharp";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const GROUP = process.argv[process.argv.indexOf("--group") + 1] || "group_sofa";
const STRENGTH = Number(process.argv[process.argv.indexOf("--strength") + 1] || 0.25);
const FINALS = process.argv.includes("--finals") ? process.argv[process.argv.indexOf("--finals") + 1] : join("outputs/finals", GROUP);
// Stage-variant selectors, mirroring run_pipeline: --no-plate writes matte_np/shadow_np/relit_np,
// --hd writes matte_hd. Without these the QC would silently read the STANDARD stages while the
// --finals folder holds a variant render.
const NP = process.argv.includes("--no-plate") || process.argv.includes("--np");
const HD = process.argv.includes("--hd");
const MATTE = `matte${NP ? "_np" : ""}${HD ? "_hd" : ""}.png`;
const STAGE = `${NP ? "_np" : ""}`;
const W = 4000;
const S = 500;                                     // analysis resolution (downsampled; we only want low-freq)

const skus = (await readdir(join("inputs", GROUP))).filter(f => f.endsWith(".jpg")).map(f => f.replace(".jpg", "")).sort();

const rows = [];
for (const sku of skus) {
  const dir = join("outputs/work", sku);
  const [mattePath, relitPath, shadowPath] = [MATTE, `relit${STAGE}.jpg`, `shadow${STAGE}.jpg`].map(f => join(dir, f));
  if (!existsSync(mattePath) || !existsSync(shadowPath)) { console.log(`skip ${sku} (no cached stages)`); continue; }

  // --- product alpha + bbox
  const alpha = await sharp(mattePath).resize(S, S, { fit: "fill" }).extractChannel(3).raw().toBuffer();
  let x0 = S, x1 = 0, y0 = S, y1 = 0, n = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (alpha[y * S + x] > 128) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const pw = x1 - x0 + 1, ph = y1 - y0 + 1, cx = (x0 + x1) / 2;

  // --- LIGHTING: lm = luma(blur(relit)), gradient over product pixels
  let light = null;
  if (existsSync(relitPath)) {
    const g = await sharp(relitPath).resize(W, W, { fit: "fill" }).blur(20).resize(S, S, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const lm = new Float32Array(S * S);
    for (let p = 0; p < S * S; p++) lm[p] = 0.2126 * g[p * 3] + 0.7152 * g[p * 3 + 1] + 0.0722 * g[p * 3 + 2];
    // least-squares plane fit of lm over product pixels → per-product-width / per-height slope
    let sw = 0, sx = 0, sy = 0, sl = 0, sxx = 0, syy = 0, sxy = 0, sxl = 0, syl = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const w = alpha[y * S + x] / 255; if (w < 0.5) continue;
      const u = (x - cx) / pw, v = ((y0 + y1) / 2 - y) / ph, l = lm[y * S + x];
      sw += 1; sx += u; sy += v; sl += l; sxx += u * u; syy += v * v; sxy += u * v; sxl += u * l; syl += v * l;
    }
    // solve 2x2 normal equations (centred, so the constant term drops out cleanly enough)
    const mx = sx / sw, my = sy / sw, ml = sl / sw;
    const Sxx = sxx - sw * mx * mx, Syy = syy - sw * my * my, Sxy = sxy - sw * mx * my;
    const Sxl = sxl - sw * mx * ml, Syl = syl - sw * my * ml;
    const det = Sxx * Syy - Sxy * Sxy;
    const bx = (Sxl * Syy - Syl * Sxy) / det, by = (Syl * Sxx - Sxl * Sxy) / det;   // luma per product-width / -height
    // convert to the % brightness the composite actually applies, edge to edge
    const pctH = (-bx / 128) * STRENGTH * 100;      // + = left brighter
    const pctV = (by / 128) * STRENGTH * 100;       // + = top brighter
    light = { pctH, pctV, mag: Math.hypot(pctH, pctV), ang: Math.atan2(pctV, pctH) * 180 / Math.PI, mean: ml };
  }

  // --- SHADOW: darker-than-white pixels outside the product
  const sh = await sharp(shadowPath).resize(S, S, { fit: "fill" }).removeAlpha().raw().toBuffer();
  let sn = 0, sxs = 0, sys = 0, dark = 0, sxMin = S, sxMax = 0, syMax = 0;
  const mask = Buffer.alloc(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const p = y * S + x;
    const l = 0.2126 * sh[p * 3] + 0.7152 * sh[p * 3 + 1] + 0.0722 * sh[p * 3 + 2];
    if (l < 245 && alpha[p] < 13) {
      mask[p] = Math.min(255, (250 - l) * 6); sn++; sxs += x; sys += y; dark += 250 - l;
      if (x < sxMin) sxMin = x; if (x > sxMax) sxMax = x; if (y > syMax) syMax = y;
    }
  }
  const shadow = sn ? {
    dx: (sxs / sn - cx) / pw,                       // centroid offset, product widths (+ = to the right)
    dy: (sys / sn - y1) / ph,                       // below the product's feet, product heights
    reachL: (cx - sxMin) / pw, reachR: (sxMax - cx) / pw,
    drop: (syMax - y1) / ph,
    area: sn / (pw * ph),                           // shadow area per product bbox area
    density: dark / sn / 250,                       // mean darkness 0..1
  } : null;
  if (shadow) shadow.ang = Math.atan2(-shadow.dy, shadow.dx) * 180 / Math.PI;

  rows.push({ sku, pw, ph, light, shadow, mask, alpha, x0, x1, y0, y1 });
  console.log(`${sku} ok`);
}

// ---------- table ----------
const f = (v, d = 2) => (v == null ? "   —  " : v.toFixed(d).padStart(6));
console.log(`\n=== ${GROUP}: lighting + shadow consistency (n=${rows.length}, strength=${STRENGTH}, stages=${MATTE}/shadow${STAGE}/relit${STAGE}) ===\n`);
console.log("SKU         │ relight Δ%  L→R   T→B   dir°  │ shadow  dx     dy   reachL reachR  area  dens  dir°");
console.log("────────────┼──────────────────────────────┼──────────────────────────────────────────────────");
for (const r of rows) {
  console.log(`${r.sku.padEnd(11)} │      ${f(r.light?.mag)} ${f(r.light?.pctH)} ${f(r.light?.pctV)} ${f(r.light?.ang, 0)}  │ ` +
    `${f(r.shadow?.dx)} ${f(r.shadow?.dy)} ${f(r.shadow?.reachL)} ${f(r.shadow?.reachR)} ${f(r.shadow?.area)} ${f(r.shadow?.density)} ${f(r.shadow?.ang, 0)}`);
}
const stat = (get) => {
  const v = rows.map(get).filter(x => x != null && Number.isFinite(x));
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
  return { m, sd, min: Math.min(...v), max: Math.max(...v) };
};
const report = (label, s, unit = "") => console.log(`${label.padEnd(28)} mean ${s.m.toFixed(2)}${unit}  sd ${s.sd.toFixed(2)}  range ${s.min.toFixed(2)} … ${s.max.toFixed(2)}`);
console.log("");
report("relight magnitude", stat(r => r.light?.mag), "%");
report("relight direction", stat(r => r.light?.ang), "°");
report("  · left→right Δ", stat(r => r.light?.pctH), "%");
report("  · top→bottom Δ", stat(r => r.light?.pctV), "%");
report("shadow direction", stat(r => r.shadow?.ang), "°");
report("shadow centroid dx", stat(r => r.shadow?.dx));
report("shadow reach (right)", stat(r => r.shadow?.reachR));
report("shadow drop below feet", stat(r => r.shadow?.drop));
report("shadow density", stat(r => r.shadow?.density));
const upperLeft = rows.filter(r => r.light && r.light.pctH > 0 && r.light.pctV > 0).length;
const shadowRight = rows.filter(r => r.shadow && r.shadow.dx > 0).length;
console.log(`\nkey light upper-LEFT on ${upperLeft}/${rows.length} SKUs · shadow falls to the RIGHT on ${shadowRight}/${rows.length} SKUs`);

// ---------- proof sheet: per SKU, final thumb + shadow mask + lighting map ----------
const T = 420, LBL = 26, C = rows.length;
const comps = [];
const cell = async (buf, col, row) => comps.push({ input: buf, left: col * T, top: row * (T + LBL) + LBL });
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const finalP = join(FINALS, `${r.sku}.jpg`);
  await cell(await sharp(finalP).resize(T, T).png().toBuffer(), i, 0);
  // shadow mask, inverted so the shadow reads dark on white, product outline in light gray
  const m = Buffer.alloc(S * S * 3, 255);
  for (let p = 0; p < S * S; p++) {
    const v = 255 - r.mask[p];
    if (r.alpha[p] > 128) { m[p * 3] = 232; m[p * 3 + 1] = 232; m[p * 3 + 2] = 236; }
    else { m[p * 3] = v; m[p * 3 + 1] = v; m[p * 3 + 2] = Math.min(255, v + 12); }
  }
  await cell(await sharp(m, { raw: { width: S, height: S, channels: 3 } }).resize(T, T).png().toBuffer(), i, 1);
  // lighting map: blurred relit, contrast-stretched so the gradient is visible
  const relitP = join("outputs/work", r.sku, `relit${STAGE}.jpg`);
  if (existsSync(relitP)) {
    await cell(await sharp(relitP).resize(T, T, { fit: "fill" }).blur(12).greyscale().normalise().png().toBuffer(), i, 2);
  }
  for (const [row, text] of [[0, r.sku], [1, `shadow  dir ${r.shadow?.ang.toFixed(0)}°  reach ${r.shadow?.reachR.toFixed(2)}`], [2, `light  ${r.light ? `${r.light.mag.toFixed(2)}% @ ${r.light.ang.toFixed(0)}°` : "—"}`]]) {
    comps.push({
      input: Buffer.from(`<svg width="${T}" height="${LBL}"><rect width="${T}" height="${LBL}" fill="#111"/><text x="7" y="18" font-size="15" font-family="monospace" fill="#eee">${text}</text></svg>`),
      left: i * T, top: row * (T + LBL),
    });
  }
}
const out = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : `outputs/qc_${GROUP}_consistency.jpg`;
await sharp({ create: { width: C * T, height: 3 * (T + LBL), channels: 3, background: "#fff" } })
  .composite(comps).jpeg({ quality: 90 }).toFile(out);
console.log(`\nproof sheet → ${out}  (row 1 = final, row 2 = isolated cast shadow, row 3 = lighting map)`);
