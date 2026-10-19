// EXPERIMENT — Gemini relight repeatability. COSTS N GEMINI CALLS.
//
//   node --env-file=.env scripts/exp_relight_repeat.mjs PE979531 3
//
// Same input (the SKU's cached shadow.jpg), same prompt, temperature 0, N runs. Each output is reduced
// to the pipeline's lighting map and compared pairwise over the product: mean absolute difference of
// the relight factor at strength 0.25, its max, and the fitted bright-side angle. The cached relit.jpg
// is included as an extra run when present. Writes only to outputs/experiments/relight_repeat/.
// Measured 2026-10-19 on PE979531, 4 maps: three agree (MAD <= 0.6%, angle within 1°); one diverged
// (angle 25° off, MAD 1.6%, max 6.5%). See docs/lighting-research-plan.md §2.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import sharp from "sharp";
import { generateShadowGemini, RELIGHT_VARIANTS } from "../src/gemini.mjs";
const sku = process.argv[2], N = parseInt(process.argv[3] || "3");
const dir = `outputs/work/${sku}`;
const W = 4000, key = process.env.GEMINI_KEY;
const shadow = await readFile(`${dir}/shadow.jpg`);
const alpha = await sharp(`${dir}/matte_hd.png`).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
const lmOf = async (buf) => { const g = await sharp(buf).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer(); const lm = new Float32Array(W * W); for (let p = 0, k = 0; p < lm.length; p++, k += 3) lm[p] = 0.299 * g[k] + 0.587 * g[k + 1] + 0.114 * g[k + 2]; return lm; };
const maps = [];
const cached = await readFile(`${dir}/relit.jpg`).catch(() => null);
if (cached) maps.push({ name: "cached", lm: await lmOf(cached) });
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  const out = await generateShadowGemini({ apiKey: key, image: shadow, instruction: RELIGHT_VARIANTS.standard, temperature: 0 });
  await mkdir("outputs/experiments/relight_repeat", { recursive: true }); await writeFile(`outputs/experiments/relight_repeat/${sku}_run${i}.jpg`, Buffer.from(out));
  maps.push({ name: `run${i}`, lm: await lmOf(Buffer.from(out)) });
  console.log(`run ${i}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
// per-map: product mean, and the relight factor swing the pipeline would apply at strength 0.25
const stats = (lm) => { let s = 0, n = 0, xs = 0, ys = 0, xx = 0, yy = 0, xy = 0, xl = 0, yl = 0; for (let p = 0; p < lm.length; p++) { if (alpha[p] < 200) continue; const x = p % W, y = (p / W) | 0, l = lm[p]; s += l; n++; xs += x; ys += y; } const mean = s / n, cx = xs / n, cy = ys / n; for (let p = 0; p < lm.length; p++) { if (alpha[p] < 200) continue; const x = (p % W) - cx, y = ((p / W) | 0) - cy, l = lm[p] - mean; xx += x * x; yy += y * y; xy += x * y; xl += x * l; yl += y * l; } const det = xx * yy - xy * xy; const gx = (yl * -xy + xl * yy) / det, gy = (yl * xx - xl * xy) / det; return { mean, gx, gy, angle: Math.atan2(-gy, gx) * 180 / Math.PI, n }; };
const S = maps.map((m) => ({ name: m.name, ...stats(m.lm) }));
for (const s of S) console.log(`${s.name.padEnd(7)} product mean ${s.mean.toFixed(1)}  gradient (per 1000 px) gx ${(s.gx * 1000).toFixed(2)} gy ${(s.gy * 1000).toFixed(2)}  bright-side angle ${s.angle.toFixed(1)}° (0=right, 90=up, 180=left)`);
// pairwise MAD of relight factor f = 1 + ((L-mean)/128)*0.25 over product
for (let i = 0; i < maps.length; i++) for (let j = i + 1; j < maps.length; j++) {
  const a = maps[i].lm, b = maps[j].lm, ma = S[i].mean, mb = S[j].mean; let d = 0, mx = 0, n = 0;
  for (let p = 0; p < a.length; p++) { if (alpha[p] < 200) continue; const fa = 1 + ((a[p] - ma) / 128) * 0.25, fb = 1 + ((b[p] - mb) / 128) * 0.25; const e = Math.abs(fa - fb); d += e; if (e > mx) mx = e; n++; }
  console.log(`${maps[i].name} vs ${maps[j].name}: relight factor MAD ${(100 * d / n).toFixed(2)}%  max ${(100 * mx).toFixed(1)}%  angle diff ${(() => { const d = Math.abs(S[i].angle - S[j].angle) % 360; return (d > 180 ? 360 - d : d).toFixed(1); })()}°`);
}
