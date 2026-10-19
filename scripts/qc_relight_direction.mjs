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
const ROOT = process.argv.slice(2).find((a) => !a.startsWith("--")) || "outputs/work", W = 1000;   // 1000² is enough for a σ20-at-4000 map
// Pipeline map: resize 4000 → blur σ20 → luma (what the composite uses), then 1000² for speed.
const luma = async (p) => { const g = await sharp(p).resize(4000, 4000, { fit: "fill" }).blur(20).resize(W, W).removeAlpha().raw().toBuffer(); const L = new Float32Array(W * W); for (let p = 0, k = 0; p < L.length; p++, k += 3) L[p] = 0.299 * g[k] + 0.587 * g[k + 1] + 0.114 * g[k + 2]; return L; };
// Unblurred luma at 1000² (for the ratio map: divide first, then blur — blur(a)/blur(b) is not blur(a/b)).
const lumaRaw = async (p) => { const g = await sharp(p).resize(W, W, { fit: "fill" }).removeAlpha().raw().toBuffer(); const L = new Float32Array(W * W); for (let p = 0, k = 0; p < L.length; p++, k += 3) L[p] = 0.299 * g[k] + 0.587 * g[k + 1] + 0.114 * g[k + 2]; return L; };
// Separable Gaussian blur on a float map (σ in px at this resolution). Plain JS: sharp's raw path is 8-bit.
const blurMap = async (M, sigma = 5) => { const r = Math.ceil(3 * sigma), k = []; let ks = 0; for (let i = -r; i <= r; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(w); ks += w; } for (let i = 0; i < k.length; i++) k[i] /= ks; const T = new Float32Array(W * W), O = new Float32Array(W * W); for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { let v = 0; for (let i = -r; i <= r; i++) { const xx = Math.min(W - 1, Math.max(0, x + i)); v += M[y * W + xx] * k[i + r]; } T[y * W + x] = v; } for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { let v = 0; for (let i = -r; i <= r; i++) { const yy = Math.min(W - 1, Math.max(0, y + i)); v += T[yy * W + x] * k[i + r]; } O[y * W + x] = v; } return O; };
// Plane fit of the relative map over product pixels. Returns the bright-side angle, the fitted swing
// across the product box (% of mean), the fit R² (how planar the map is — a low R² means "direction"
// is not a meaningful summary of this map), and the product's mean map value.
const fit = (M, a) => { let s = 0, n = 0, xs = 0, ys = 0, x0 = W, x1 = 0, y0 = W, y1 = 0; for (let p = 0; p < M.length; p++) if (a[p] >= 200) { s += M[p]; n++; const x = p % W, y = (p / W) | 0; xs += x; ys += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } const mean = s / n, cx = xs / n, cy = ys / n; let xx = 0, yy = 0, xy = 0, xf = 0, yf = 0; for (let p = 0; p < M.length; p++) { if (a[p] < 200) continue; const x = (p % W) - cx, y = ((p / W) | 0) - cy, f = M[p] / mean - 1; xx += x * x; yy += y * y; xy += x * y; xf += x * f; yf += y * f; } const det = xx * yy - xy * xy, gx = (xf * yy - yf * xy) / det, gy = (yf * xx - xf * xy) / det; let ssr = 0, sst = 0; for (let p = 0; p < M.length; p++) { if (a[p] < 200) continue; const x = (p % W) - cx, y = ((p / W) | 0) - cy, f = M[p] / mean - 1, e = f - (gx * x + gy * y); ssr += e * e; sst += f * f; }
  return { angle: Math.atan2(-gy, gx) * 180 / Math.PI, swing: Math.hypot(gx * (x1 - x0), gy * (y1 - y0)) * 100, r2: sst > 0 ? 1 - ssr / sst : 0, mean }; };
const abs = [], rat = [];
for (const sku of (await readdir(ROOT)).sort()) {
  const d = `${ROOT}/${sku}`; const ok = async (f) => stat(`${d}/${f}`).then(() => true, () => false);
  if (!(await ok("relit.jpg")) || !(await ok("shadow.jpg"))) continue;
  const matte = (await ok("matte_hd.png")) ? `${d}/matte_hd.png` : (await ok("matte.png")) ? `${d}/matte.png` : null; if (!matte) continue;
  const a = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  let n = 0; for (let p = 0; p < a.length; p++) if (a[p] >= 200) n++; if (n < 500) continue;
  const Lr = await luma(`${d}/relit.jpg`);
  const rr = await lumaRaw(`${d}/relit.jpg`), rb = await lumaRaw(`${d}/shadow.jpg`);
  const R0 = new Float32Array(W * W); for (let p = 0; p < R0.length; p++) R0[p] = rr[p] / Math.max(rb[p], 8);   // divide first (floor 8 against noise in dark pixels)
  const R = await blurMap(R0);                                                                                   // then blur (σ5 at 1000² ≈ σ20 at 4000²)
  const fa = fit(Lr, a), fr = fit(R, a);
  // What the composite applies at strength 0.25: f = 1 + ((L − mean)/128)·0.25 = 1 + (L/mean − 1)·(mean/128·0.25).
  // So the effective gain on the relative map is mean/128·0.25 — it depends on the product's own brightness.
  const gain = fa.mean / 128 * 0.25;
  abs.push({ sku, ...fa, gain, appliedSwing: fa.swing * gain }); rat.push({ sku, ...fr });
}
const circ = (deg) => { let c = 0, s = 0; for (const d of deg) { c += Math.cos(d * Math.PI / 180); s += Math.sin(d * Math.PI / 180); } c /= deg.length; s /= deg.length; const Rb = Math.hypot(c, s); return { mean: Math.atan2(s, c) * 180 / Math.PI, sd: Math.sqrt(-2 * Math.log(Math.max(Rb, 1e-9))) * 180 / Math.PI }; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length, sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
const SKUS = process.argv.includes("--per-sku");
if (SKUS) for (let i = 0; i < abs.length; i++) console.log(`${abs[i].sku.padEnd(10)} abs ${abs[i].angle.toFixed(0).padStart(5)}° R² ${abs[i].r2.toFixed(2)} swing ${abs[i].swing.toFixed(0).padStart(3)}% mean ${abs[i].mean.toFixed(0).padStart(3)} gain ${abs[i].gain.toFixed(2)} applied ${abs[i].appliedSwing.toFixed(1).padStart(5)}%  |  ratio ${rat[i].angle.toFixed(0).padStart(5)}° R² ${rat[i].r2.toFixed(2)} swing ${rat[i].swing.toFixed(0).padStart(3)}%`);
const G = abs.map((r) => r.gain), AS = abs.map((r) => r.appliedSwing);
console.log(`effective gain (mean/128·0.25): min ${Math.min(...G).toFixed(2)} max ${Math.max(...G).toFixed(2)} ratio ${(Math.max(...G) / Math.min(...G)).toFixed(1)}×  |  applied swing at strength 0.25: mean ${mean(AS).toFixed(1)}% sd ${sd(AS).toFixed(1)}% CV ${(100 * sd(AS) / mean(AS)).toFixed(0)}%`);
for (const [name, rows] of [["ABSOLUTE (what the pipeline applies)", abs], ["RATIO relit/input, divided before blur", rat]]) {
  const A = rows.map((r) => r.angle), Sw = rows.map((r) => r.swing), c = circ(A);
  const inUL = A.filter((x) => x >= 90 && x <= 180).length, inLeft = A.filter((x) => x >= 90 || x <= -90).length;
  const R2 = rows.map((r) => r.r2), weak = rows.filter((r) => r.r2 < 0.3).length;
  console.log(`${name}: n=${rows.length} circular mean ${c.mean.toFixed(0)}° circular sd ${c.sd.toFixed(0)}°  bright side upper-left ${inUL}/${rows.length}, left half ${inLeft}/${rows.length}  | relative swing mean ${mean(Sw).toFixed(1)}% sd ${sd(Sw).toFixed(1)}% CV ${(100 * sd(Sw) / mean(Sw)).toFixed(0)}%  | plane-fit R² median ${R2.sort((a, b) => a - b)[R2.length >> 1].toFixed(2)}, ${weak} maps with R² < 0.3 (direction not meaningful)`);
}
console.log("\nratio-map outliers (bright side not in 90..180):"); for (const r of rat) if (r.angle < 90 || r.angle > 180) console.log(`  ${r.sku} ${r.angle.toFixed(0)}° swing ${r.swing.toFixed(1)}%`);
