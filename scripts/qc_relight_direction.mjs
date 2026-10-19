// QC: direction and swing of the applied relight, per SKU, from cached stages (no API calls).
//
//   node scripts/qc_relight_direction.mjs [outputs/work]
//
// For every SKU with relit.jpg + shadow.jpg + a matte, builds the lighting map exactly as the pipeline
// does (resize 4000, blur 20, Rec. 601 luma) and plane-fits it over product pixels (alpha >= 200):
//   ABSOLUTE  — the map the pipeline applies. Includes the product's own albedo (a pale leg under a
//               dark seat reads as "light from below"), so this is what the composite really does.
//   RATIO     — relit / shadow-render luminance, which cancels albedo and leaves the change Gemini made.
// Angle convention: bright side of the product, 0° = right, 90° = up, 180° = left; "upper-left" = 90..180.
// Swing = fitted relative luminance change across the product box along the gradient, in %.
// Circular mean/sd so angles near ±180° do not average to zero. Measured 2026-10-19 on 50 SKUs:
// absolute circular sd 49°, ratio 26° — see docs/lighting-research-plan.md §2.
import { readdir, stat } from "node:fs/promises";
import sharp from "sharp";
const ROOT = process.argv[2] || "outputs/work", W = 1000;   // 1000² is enough for a σ20-at-4000 map
const luma = async (p) => { const g = await sharp(p).resize(4000, 4000, { fit: "fill" }).blur(20).resize(W, W).removeAlpha().raw().toBuffer(); const L = new Float32Array(W * W); for (let p = 0, k = 0; p < L.length; p++, k += 3) L[p] = 0.299 * g[k] + 0.587 * g[k + 1] + 0.114 * g[k + 2]; return L; };
const fit = (M, a) => { let s = 0, n = 0, xs = 0, ys = 0, x0 = W, x1 = 0, y0 = W, y1 = 0; for (let p = 0; p < M.length; p++) if (a[p] >= 200) { s += M[p]; n++; const x = p % W, y = (p / W) | 0; xs += x; ys += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } const mean = s / n, cx = xs / n, cy = ys / n; let xx = 0, yy = 0, xy = 0, xf = 0, yf = 0; for (let p = 0; p < M.length; p++) { if (a[p] < 200) continue; const x = (p % W) - cx, y = ((p / W) | 0) - cy, f = M[p] / mean - 1; xx += x * x; yy += y * y; xy += x * y; xf += x * f; yf += y * f; } const det = xx * yy - xy * xy, gx = (xf * yy - yf * xy) / det, gy = (yf * xx - xf * xy) / det; return { angle: Math.atan2(-gy, gx) * 180 / Math.PI, swing: Math.hypot(gx * (x1 - x0), gy * (y1 - y0)) * 100 }; };
const abs = [], rat = [];
for (const sku of (await readdir(ROOT)).sort()) {
  const d = `${ROOT}/${sku}`; const ok = async (f) => stat(`${d}/${f}`).then(() => true, () => false);
  if (!(await ok("relit.jpg")) || !(await ok("shadow.jpg"))) continue;
  const matte = (await ok("matte_hd.png")) ? `${d}/matte_hd.png` : (await ok("matte.png")) ? `${d}/matte.png` : null; if (!matte) continue;
  const a = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  let n = 0; for (let p = 0; p < a.length; p++) if (a[p] >= 200) n++; if (n < 500) continue;
  const Lr = await luma(`${d}/relit.jpg`), Lb = await luma(`${d}/shadow.jpg`);
  const R = new Float32Array(W * W); for (let p = 0; p < R.length; p++) R[p] = Lr[p] / Math.max(Lb[p], 1);
  const fa = fit(Lr, a), fr = fit(R, a);
  abs.push(fa); rat.push({ sku, ...fr });
}
const circ = (deg) => { let c = 0, s = 0; for (const d of deg) { c += Math.cos(d * Math.PI / 180); s += Math.sin(d * Math.PI / 180); } c /= deg.length; s /= deg.length; const Rb = Math.hypot(c, s); return { mean: Math.atan2(s, c) * 180 / Math.PI, sd: Math.sqrt(-2 * Math.log(Math.max(Rb, 1e-9))) * 180 / Math.PI }; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length, sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
for (const [name, rows] of [["ABSOLUTE (what the pipeline applies)", abs], ["RATIO relit/input (albedo cancelled)", rat]]) {
  const A = rows.map((r) => r.angle), Sw = rows.map((r) => r.swing), c = circ(A);
  const inUL = A.filter((x) => x >= 90 && x <= 180).length, inLeft = A.filter((x) => x >= 90 || x <= -90).length;
  console.log(`${name}: n=${rows.length} circular mean ${c.mean.toFixed(0)}° circular sd ${c.sd.toFixed(0)}°  bright side upper-left ${inUL}/${rows.length}, left half ${inLeft}/${rows.length}  | swing mean ${mean(Sw).toFixed(1)}% sd ${sd(Sw).toFixed(1)}% CV ${(100 * sd(Sw) / mean(Sw)).toFixed(0)}%`);
}
console.log("\nratio-map outliers (bright side not in 90..180):"); for (const r of rat) if (r.angle < 90 || r.angle > 180) console.log(`  ${r.sku} ${r.angle.toFixed(0)}° swing ${r.swing.toFixed(1)}%`);
