// QC: direction and swing of the applied relight, per SKU, from cached stages (no API calls).
//
//   node scripts/qc_relight_direction.mjs [outputs/work] [--per-sku]
//
// For every SKU with relit.jpg + shadow.jpg + a matte, builds the lighting map exactly as the pipeline
// does (resize 4000, blur σ20, Rec. 601 luma) and plane-fits it over product pixels (alpha ≥ 200):
//   ABSOLUTE — the map the pipeline applies. It includes the product's own albedo (a pale leg under a
//              dark seat reads as "light from below"), so this is what the composite really does.
//   RATIO    — relit ÷ shadow render, divided per pixel BEFORE blurring (blur(a)/blur(b) ≠ blur(a/b));
//              approximately cancels albedo and leaves the change Gemini made.
// Angle: bright side of the product, 0° = right, 90° = up, 180° = left; "upper-left" = 90..180.
// Swing: fitted relative change across the product box along the gradient, in % of the mean.
// R²: how planar the map is; below ~0.3 a single direction does not describe it.
// Gain: what the composite applies at strength 0.25 is f = 1 + (L/mean − 1)·(mean/128·0.25), so the
// effective gain on the relative map is mean/128·0.25 — it depends on the product's own brightness.
// Numbers and interpretation: docs/lighting-research-plan.md §2.

import { readdir, stat } from "node:fs/promises";
import sharp from "sharp";

const ROOT = process.argv.slice(2).find((a) => !a.startsWith("--")) || "outputs/work";
const PER_SKU = process.argv.includes("--per-sku");
const W = 1000;                       // 1000² is enough for a σ20-at-4000 map
const STRENGTH = 0.25, OPAQUE = 200, MIN_PIXELS = 500;

const exists = (p) => stat(p).then(() => true, () => false);
const luma = (g, k) => 0.299 * g[k] + 0.587 * g[k + 1] + 0.114 * g[k + 2];

// The pipeline's map: resize 4000 → blur σ20 → luma, then 1000² for speed.
async function pipelineMap(path) {
  const g = await sharp(path).resize(4000, 4000, { fit: "fill" }).blur(20).resize(W, W).removeAlpha().raw().toBuffer();
  const L = new Float32Array(W * W);
  for (let p = 0, k = 0; p < L.length; p++, k += 3) L[p] = luma(g, k);
  return L;
}
// Unblurred luma at 1000², for the ratio map.
async function rawMap(path) {
  const g = await sharp(path).resize(W, W, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const L = new Float32Array(W * W);
  for (let p = 0, k = 0; p < L.length; p++, k += 3) L[p] = luma(g, k);
  return L;
}
// Separable Gaussian on a float map (σ in px at this resolution; σ5 here ≈ σ20 at 4000²).
function blurMap(M, sigma = 5) {
  const r = Math.ceil(3 * sigma), k = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(w); ks += w; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const pass = (src, dst, step, stride) => {
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const q = step === 1 ? Math.min(W - 1, Math.max(0, x + i)) : x;
        const row = step === 1 ? y : Math.min(W - 1, Math.max(0, y + i));
        v += src[row * stride + q] * k[i + r];
      }
      dst[y * stride + x] = v;
    }
  };
  const T = new Float32Array(W * W), O = new Float32Array(W * W);
  pass(M, T, 1, W);   // horizontal
  pass(T, O, 0, W);   // vertical
  return O;
}

// Least-squares plane through the relative map (M/mean − 1) over product pixels.
function planeFit(M, alpha) {
  let n = 0, sum = 0, xs = 0, ys = 0, x0 = W, x1 = 0, y0 = W, y1 = 0;
  for (let p = 0; p < M.length; p++) {
    if (alpha[p] < OPAQUE) continue;
    const x = p % W, y = (p / W) | 0;
    n++; sum += M[p]; xs += x; ys += y;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const mean = sum / n, cx = xs / n, cy = ys / n;
  let xx = 0, yy = 0, xy = 0, xf = 0, yf = 0;
  for (let p = 0; p < M.length; p++) {
    if (alpha[p] < OPAQUE) continue;
    const x = (p % W) - cx, y = ((p / W) | 0) - cy, f = M[p] / mean - 1;
    xx += x * x; yy += y * y; xy += x * y; xf += x * f; yf += y * f;
  }
  const det = xx * yy - xy * xy, gx = (xf * yy - yf * xy) / det, gy = (yf * xx - xf * xy) / det;
  let ssr = 0, sst = 0;
  for (let p = 0; p < M.length; p++) {
    if (alpha[p] < OPAQUE) continue;
    const x = (p % W) - cx, y = ((p / W) | 0) - cy, f = M[p] / mean - 1, e = f - (gx * x + gy * y);
    ssr += e * e; sst += f * f;
  }
  return {
    n, mean,
    angle: Math.atan2(-gy, gx) * 180 / Math.PI,
    swing: Math.hypot(gx * (x1 - x0), gy * (y1 - y0)) * 100,
    r2: sst > 0 ? 1 - ssr / sst : 0,
  };
}

const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
const median = (v) => [...v].sort((a, b) => a - b)[v.length >> 1];
function circular(deg) {
  let c = 0, s = 0;
  for (const d of deg) { c += Math.cos(d * Math.PI / 180); s += Math.sin(d * Math.PI / 180); }
  c /= deg.length; s /= deg.length;
  return { mean: Math.atan2(s, c) * 180 / Math.PI, sd: Math.sqrt(-2 * Math.log(Math.max(Math.hypot(c, s), 1e-9))) * 180 / Math.PI };
}

const abs = [], ratio = [];
for (const sku of (await readdir(ROOT)).sort()) {
  const d = `${ROOT}/${sku}`;
  if (!(await exists(`${d}/relit.jpg`)) || !(await exists(`${d}/shadow.jpg`))) continue;
  const matte = (await exists(`${d}/matte_hd.png`)) ? `${d}/matte_hd.png` : (await exists(`${d}/matte.png`)) ? `${d}/matte.png` : null;
  if (!matte) continue;
  const alpha = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  if (alpha.filter((a) => a >= OPAQUE).length < MIN_PIXELS) continue;

  const absolute = await pipelineMap(`${d}/relit.jpg`);
  const relitRaw = await rawMap(`${d}/relit.jpg`), baseRaw = await rawMap(`${d}/shadow.jpg`);
  const quotient = new Float32Array(W * W);
  for (let p = 0; p < quotient.length; p++) quotient[p] = relitRaw[p] / Math.max(baseRaw[p], 8);   // floor 8: noise in dark pixels
  const fa = planeFit(absolute, alpha), fr = planeFit(blurMap(quotient), alpha);
  const gain = fa.mean / 128 * STRENGTH;
  abs.push({ sku, ...fa, gain, appliedSwing: fa.swing * gain });
  ratio.push({ sku, ...fr });
}

if (PER_SKU) for (let i = 0; i < abs.length; i++) {
  const a = abs[i], r = ratio[i];
  console.log(`${a.sku.padEnd(10)} abs ${a.angle.toFixed(0).padStart(5)}° R² ${a.r2.toFixed(2)} swing ${a.swing.toFixed(0).padStart(3)}% mean ${a.mean.toFixed(0).padStart(3)} gain ${a.gain.toFixed(2)} applied ${a.appliedSwing.toFixed(1).padStart(5)}%  |  ratio ${r.angle.toFixed(0).padStart(5)}° R² ${r.r2.toFixed(2)} swing ${r.swing.toFixed(0).padStart(3)}%`);
}
const G = abs.map((r) => r.gain), AS = abs.map((r) => r.appliedSwing);
console.log(`effective gain (mean/128·${STRENGTH}): min ${Math.min(...G).toFixed(2)} max ${Math.max(...G).toFixed(2)} ratio ${(Math.max(...G) / Math.min(...G)).toFixed(1)}×  |  applied swing at strength ${STRENGTH}: mean ${mean(AS).toFixed(1)}% sd ${sd(AS).toFixed(1)}% CV ${(100 * sd(AS) / mean(AS)).toFixed(0)}%`);
for (const [name, rows] of [["ABSOLUTE (what the pipeline applies)", abs], ["RATIO relit/input, divided before blur", ratio]]) {
  const A = rows.map((r) => r.angle), Sw = rows.map((r) => r.swing), R2 = rows.map((r) => r.r2), c = circular(A);
  const upperLeft = A.filter((x) => x >= 90 && x <= 180).length, left = A.filter((x) => x >= 90 || x <= -90).length;
  console.log(`${name}: n=${rows.length} circular mean ${c.mean.toFixed(0)}° circular sd ${c.sd.toFixed(0)}°  bright side upper-left ${upperLeft}/${rows.length}, left half ${left}/${rows.length}  | relative swing mean ${mean(Sw).toFixed(1)}% sd ${sd(Sw).toFixed(1)}% CV ${(100 * sd(Sw) / mean(Sw)).toFixed(0)}%  | plane-fit R² median ${median(R2).toFixed(2)}, ${R2.filter((x) => x < 0.3).length} maps with R² < 0.3 (direction not meaningful)`);
}
console.log("\nratio-map outliers (bright side not in 90..180):");
for (const r of ratio) if (r.angle < 90 || r.angle > 180) console.log(`  ${r.sku} ${r.angle.toFixed(0)}° swing ${r.swing.toFixed(1)}%`);
