// DEBUG EXPERIMENT — the "white line" around dark feet in the opaque composite.
//
// Diagnosis (verified): the composite darkens the chosen bg by a shadow FACTOR
//     sf = (a*255 + (1-a)*luminance(shadowRender)) / 255
// The `a*255` term masks the PRODUCT's own darkness out of the bg (so a dark product doesn't
// paint a dark halo on a non-white bg). But in the soft-alpha RING just outside the silhouette,
// `a` is fractional, so `a*255` injects brightness → the real cast/contact shadow is cancelled
// right at the contour, leaving a bright rim of un-shadowed floor between the near-black paw and
// the darker shadow beyond. Worst on the panda (pure-black paws over the densest shadow).
//
// This does NOT touch the pipeline. It reuses the cached matte + WHITE shadow render written by
// exp_referencebox.mjs (outputs/experiments/referencebox/<sku>_matte.png / _shadow.jpg) — no API
// calls — and re-composites on F7F7F7 three ways for comparison:
//   V0  current            sf = (a*255 + (1-a)*L) / 255
//   V1  drop the mask      sf = L / 255                         (ring follows the shadow → grounded)
//   V2  harden the gate    sf = (aG*255 + (1-aG)*L) / 255,  aG = smoothstep(0.6,1,a)
//                          (brightening only near the opaque core, where (1-a)≈0, so no visible ring;
//                           keeps the product-body mask that protects non-white backgrounds)
//
//   node scripts/exp_shadowfix_whiteline.mjs [SKU ...] [--bg F7F7F7]

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BG = arg("--bg", "F7F7F7").toUpperCase();
const SKUS = argv.filter((a) => /^PE\d+$/.test(a));
if (!SKUS.length) SKUS.push("PE317642", "PE371748", "PE936323", "PE964848");

const SRC = "outputs/experiments/referencebox";
const OUT = "outputs/experiments/shadowfix";
const W = 4000;
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const bgR = parseInt(BG.slice(0, 2), 16), bgG = parseInt(BG.slice(2, 4), 16), bgB = parseInt(BG.slice(4, 6), 16);

// feet / ground crops (native 4000² coords) for a close look at the contact edge
const FEET = {
  PE317642: { left: 1150, top: 2650, width: 1500, height: 900 },
  PE371748: { left: 1050, top: 2700, width: 1700, height: 900 },
  PE936323: { left: 700,  top: 2650, width: 1900, height: 700 },
  PE964848: { left: 900,  top: 2650, width: 1700, height: 900 },
};

function composite(subj, A, base, variant) {
  const out = Buffer.alloc(W * W * 3);
  for (let p = 0, i = 0; p < W * W; p++, i += 3) {
    const a = A[p] / 255;
    const L = gray(base[i], base[i + 1], base[i + 2]);
    let sf;
    if (variant === "V0") sf = (a * 255 + (1 - a) * L) / 255;
    else if (variant === "V1") sf = L / 255;
    else { const aG = smoothstep(0.6, 1.0, a); sf = (aG * 255 + (1 - aG) * L) / 255; }
    out[i]     = clamp(subj[i]     * a + bgR * sf * (1 - a));
    out[i + 1] = clamp(subj[i + 1] * a + bgG * sf * (1 - a));
    out[i + 2] = clamp(subj[i + 2] * a + bgB * sf * (1 - a));
  }
  return out;
}

await mkdir(OUT, { recursive: true });

// horizontal strip of labelled crops
async function strip(items, cellW, cellH, path) {
  const L = 34;
  const label = (t) => Buffer.from(`<svg width="${cellW}" height="${L}"><rect width="100%" height="100%" fill="black"/><text x="10" y="24" font-family="monospace" font-size="22" fill="white">${t}</text></svg>`);
  const cells = [];
  for (const { bytes, title } of items) {
    cells.push(await sharp({ create: { width: cellW, height: cellH + L, channels: 3, background: "#fff" } })
      .composite([{ input: await sharp(bytes).resize(cellW, cellH, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).toBuffer(), top: L, left: 0 }, { input: label(title), top: 0, left: 0 }]).png().toBuffer());
  }
  await sharp({ create: { width: cellW * items.length, height: cellH + L, channels: 3, background: "#222" } })
    .composite(cells.map((c, i) => ({ input: c, left: i * cellW, top: 0 }))).jpeg({ quality: 92 }).toFile(path);
}

for (const sku of SKUS) {
  process.stdout.write(`${sku} ... `);
  try {
    const matte = join(SRC, `${sku}_matte.png`), shadow = join(SRC, `${sku}_shadow.jpg`);
    const subj = await sharp(await readFile(matte)).resize(W, W).removeAlpha().raw().toBuffer();
    const A    = await sharp(await readFile(matte)).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
    const base = await sharp(await readFile(shadow)).resize(W, W).removeAlpha().raw().toBuffer();

    const variants = ["V0", "V1", "V2"];
    const raw = {};
    for (const v of variants) raw[v] = composite(subj, A, base, v);
    const jpeg = async (buf) => sharp(buf, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();

    // feet crop strip (native res) + full-frame strip (downscaled)
    const c = FEET[sku];
    const feetItems = await Promise.all(variants.map(async (v) => ({ title: `${v}${v === "V0" ? " current" : v === "V1" ? " drop-mask" : " hard-gate"}`, bytes: await sharp(raw[v], { raw: { width: W, height: W, channels: 3 } }).extract(c).png().toBuffer() })));
    await strip(feetItems, c.width, c.height, join(OUT, `${sku}_feet_V0V1V2.jpg`));
    const fullItems = await Promise.all(variants.map(async (v) => ({ title: v, bytes: await jpeg(raw[v]) })));
    await strip(fullItems, 1000, 1000, join(OUT, `${sku}_full_V0V1V2.jpg`));

    // brightest floor pixel hugging a foot underside (the "white line" metric), per variant
    const report = variants.map((v) => {
      const o = raw[v]; let maxL = 0;
      for (let y = c.top; y < c.top + c.height; y++) for (let x = c.left; x < c.left + c.width; x++) {
        const p = y * W + x; if (A[p] > 12) continue;               // floor only
        let nearFoot = false; for (let dy = 1; dy <= 10 && !nearFoot; dy++) if (A[(y - dy) * W + x] > 180) nearFoot = true;
        if (!nearFoot) continue;
        const i = p * 3, L = gray(o[i], o[i + 1], o[i + 2]); if (L > maxL) maxL = L;
      }
      return `${v}=${Math.round(maxL)}`;
    });
    console.log(`ok  | brightest floor px hugging foot: ${report.join("  ")}  (bg=${gray(bgR, bgG, bgB) | 0})`);
  } catch (e) {
    console.log("FAIL: " + e.message);
  }
}
console.log(`\nDone → ${OUT}/  (*_feet_V0V1V2.jpg, *_full_V0V1V2.jpg)`);
