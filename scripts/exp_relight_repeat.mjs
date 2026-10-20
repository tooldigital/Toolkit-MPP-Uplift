// EXPERIMENT — Gemini relight repeatability. COSTS N GEMINI CALLS.
//
//   node --env-file=.env scripts/exp_relight_repeat.mjs PE979531 3
//
// Same input (the SKU's cached shadow.jpg), same prompt, temperature 0, N runs. Each output is reduced
// to the pipeline's lighting map and compared pairwise over the product: mean absolute difference of
// the relight factor at strength 0.25, its max, and the fitted bright-side angle. The cached relit.jpg
// is included as an extra map when present. Writes only to outputs/experiments/relight_repeat/.
// Measured 2026-10-19 on PE979531, 4 maps: three agreed (MAD ≤ 0.6%, angle within 1°); one diverged
// (angle 25° off, MAD 1.6%, max 6.5%). See docs/lighting-research-plan.md §2.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import sharp from "sharp";
import { generateShadowGemini, RELIGHT_VARIANTS } from "../src/gemini.mjs";

const sku = process.argv[2], N = parseInt(process.argv[3] || "3");
if (!sku) { console.error("usage: exp_relight_repeat.mjs <sku> [runs]"); process.exit(1); }
const dir = `outputs/work/${sku}`, OUT = "outputs/experiments/relight_repeat";
const W = 4000, STRENGTH = 0.25, OPAQUE = 200;

const shadow = await readFile(`${dir}/shadow.jpg`);
const alpha = await sharp(`${dir}/matte_hd.png`).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();

async function lightmap(buf) {
  const g = await sharp(buf).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
  const lm = new Float32Array(W * W);
  for (let p = 0, k = 0; p < lm.length; p++, k += 3) lm[p] = 0.299 * g[k] + 0.587 * g[k + 1] + 0.114 * g[k + 2];
  return lm;
}
// Product mean and the fitted bright-side angle (0° = right, 90° = up, 180° = left).
function stats(lm) {
  let n = 0, sum = 0, xs = 0, ys = 0;
  for (let p = 0; p < lm.length; p++) if (alpha[p] >= OPAQUE) { n++; sum += lm[p]; xs += p % W; ys += (p / W) | 0; }
  const mean = sum / n, cx = xs / n, cy = ys / n;
  let xx = 0, yy = 0, xy = 0, xl = 0, yl = 0;
  for (let p = 0; p < lm.length; p++) {
    if (alpha[p] < OPAQUE) continue;
    const x = (p % W) - cx, y = ((p / W) | 0) - cy, l = lm[p] - mean;
    xx += x * x; yy += y * y; xy += x * y; xl += x * l; yl += y * l;
  }
  const det = xx * yy - xy * xy, gx = (xl * yy - yl * xy) / det, gy = (yl * xx - xl * xy) / det;
  return { mean, gx, gy, angle: Math.atan2(-gy, gx) * 180 / Math.PI };
}
const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

const maps = [];
const cached = await readFile(`${dir}/relit.jpg`).catch(() => null);
if (cached) maps.push({ name: "cached", lm: await lightmap(cached) });
await mkdir(OUT, { recursive: true });
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  const out = Buffer.from(await generateShadowGemini({ apiKey: process.env.GEMINI_KEY, image: shadow, instruction: RELIGHT_VARIANTS.standard, temperature: 0 }));
  await writeFile(`${OUT}/${sku}_run${i}.jpg`, out);
  maps.push({ name: `run${i}`, lm: await lightmap(out) });
  console.log(`run ${i}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

const S = maps.map((m) => ({ name: m.name, ...stats(m.lm) }));
for (const s of S) console.log(`${s.name.padEnd(7)} product mean ${s.mean.toFixed(1)}  gradient (per 1000 px) gx ${(s.gx * 1000).toFixed(2)} gy ${(s.gy * 1000).toFixed(2)}  bright-side angle ${s.angle.toFixed(1)}°`);
for (let i = 0; i < maps.length; i++) for (let j = i + 1; j < maps.length; j++) {
  const a = maps[i].lm, b = maps[j].lm;
  let d = 0, mx = 0, n = 0;
  for (let p = 0; p < a.length; p++) {
    if (alpha[p] < OPAQUE) continue;
    const e = Math.abs(((a[p] - S[i].mean) - (b[p] - S[j].mean)) / 128 * STRENGTH);
    d += e; if (e > mx) mx = e; n++;
  }
  console.log(`${maps[i].name} vs ${maps[j].name}: relight factor MAD ${(100 * d / n).toFixed(2)}%  max ${(100 * mx).toFixed(1)}%  angle diff ${angleDiff(S[i].angle, S[j].angle).toFixed(1)}°`);
}
