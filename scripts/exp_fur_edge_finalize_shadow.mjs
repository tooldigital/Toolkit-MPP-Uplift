// Band finals on WHITE that KEEP the Photoroom cast shadow: composite the band product over the
// Photoroom shadow render (shadow.jpg) instead of over pure white.
//   P    = subj*(a*I) + gem*(1-a*I)                 (band product, feathered fur edge; R=90)
//   cov  = max( smoothstep(matte alpha), gemFurCov )  product+strand coverage (gem carries NO shadow,
//          so the cast-shadow ground stays cov≈0 and shows through)
//   out  = (P * relight) * cov + shadowRender * (1 - cov)
// No bg-lock needed — shadowRender's far bg is already Photoroom white. No Gemini calls.
//
//   node scripts/exp_fur_edge_finalize_shadow.mjs PE317642 PE371748 PE936323 PE964848 [--R 90] [--strength 0.08] [--gem B]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { harvestShadow } from "../src/shadow-patch.mjs";

const K = process.env.GEMINI_KEY;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const R = parseInt(arg("--R", "90"), 10);
const STRENGTH = parseFloat(arg("--strength", "0.08"));
const GEM = arg("--gem", "B").toUpperCase();
// --nostrands: coverage = matte alpha ONLY (drop gemFur). gemFur pulls gem's non-white pixels into
// coverage to catch DRAWN strands (gem_B); with gem_A (recolor, no strands) it instead pulls gem's
// own baked cast shadow in as "product", which double-composites against the base shadow. Off here.
const NOSTRANDS = process.argv.includes("--nostrands");
const BG = arg("--bg", "FFFFFF").replace(/^#/, "").toUpperCase();
const [BR, BGc, BB] = [parseInt(BG.slice(0, 2), 16), parseInt(BG.slice(2, 4), 16), parseInt(BG.slice(4, 6), 16)];
const skus = process.argv.slice(2).filter((a) => /^PE/i.test(a));
if (skus.length === 0) { console.error("usage: exp_fur_edge_finalize_shadow.mjs <sku..> [--bg F7F7F7]"); process.exit(1); }

const W = 4000;
const GEMDIR = "outputs/experiments/fur_edge";
const OUTDIR = `outputs/finals_plush_furedge_shadow${BG === "FFFFFF" ? "" : "_" + BG.toLowerCase()}/group_plush`;
await mkdir(OUTDIR, { recursive: true });
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const exists = (p) => readFile(p).then(() => true, () => false);

for (const sku of skus) {
  try {
    const dir = `outputs/work/${sku}`;
    const matte = await readFile(join(dir, "matte.png"));
    const relit = await readFile(join(dir, "relit.jpg"));
    const shadowBytes = await readFile(join(dir, "shadow.jpg"));    // Photoroom product-on-white + cast shadow

    const subj = await sharp(matte).resize(W, W).removeAlpha().raw().toBuffer();
    const gem  = await sharp(join(GEMDIR, `${sku}_gem_${GEM}.jpg`)).resize(W, W).removeAlpha().raw().toBuffer();
    const a    = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();

    // Photoroom shadow base — but if it's BLANK (flat products like the otter defeat generateShadow),
    // fall back to a Gemini-harvested shadow (rendered on the flat product, keep only the ground shadow).
    let base;
    const prBase = await sharp(shadowBytes).resize(W, W).removeAlpha().raw().toBuffer();
    let groundMin = 255;   // darkest ground (outside product) pixel — high ⇒ blank shadow
    for (let p = 0, i = 0; p < W * W; p++, i += 3) if (a[p] < 26) { const l = gray(prBase[i], prBase[i + 1], prBase[i + 2]); if (l < groundMin) groundMin = l; }
    const harvest = groundMin > 240;
    if (harvest) {
      const hp = join(dir, "shadow_harvest.jpg");
      if (await exists(hp)) { base = await sharp(await readFile(hp)).resize(W, W).removeAlpha().raw().toBuffer(); }
      else {
        if (!K) throw new Error("Photoroom shadow blank and no cached harvest; set GEMINI_KEY");
        process.stdout.write(`${sku}: Photoroom shadow blank (groundMin=${groundMin.toFixed(0)}) → harvesting Gemini shadow ...`);
        const { withShadow } = await harvestShadow({ apiKey: K, matteBytes: matte, size: W });
        await sharp(withShadow, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toFile(hp);
        base = withShadow;
        process.stdout.write(" ok\n");
      }
    } else {
      base = prBase;
    }
    const AbR  = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(R).raw().toBuffer();
    const Ab15 = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").blur(15).raw().toBuffer();
    const gmap = await sharp(relit).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
    const N = W * W;
    const lm = new Float32Array(N);
    for (let p = 0, k = 0; p < N; p++, k += 3) lm[p] = gray(gmap[k], gmap[k + 1], gmap[k + 2]);
    let gs = 0, aw = 0; for (let p = 0; p < N; p++) { const av = a[p] / 255; gs += lm[p] * av; aw += av; }
    const mean = aw > 0 ? gs / aw : 128;

    const out = Buffer.alloc(N * 3);
    for (let p = 0, i = 0; p < N; p++, i += 3) {
      const I = smoothstep(0.55, 0.92, AbR[p] / 255);
      const pw = (a[p] / 255) * I;
      const rl = 1 + ((lm[p] - mean) / 128) * STRENGTH * smoothstep(0.02, 0.20, Ab15[p] / 255);
      // gem-fur coverage: gem has NO shadow, so non-white(gem) = fur/strands only (cast shadow stays 0)
      const gemFur = NOSTRANDS ? 0 : smoothstep(0.10, 0.28, 1 - Math.min(gem[i], gem[i + 1], gem[i + 2]) / 255);
      const cov = Math.max(smoothstep(0.10, 0.55, a[p] / 255), gemFur);   // product (+ strands unless --nostrands)
      const sf = Math.min(1, gray(base[i], base[i + 1], base[i + 2]) / 255);   // shadow factor from the render
      const gcol = [BR, BGc, BB];
      for (let c = 0; c < 3; c++) {
        const P = subj[i + c] * pw + gem[i + c] * (1 - pw);   // band product (feathered edge)
        out[i + c] = clamp(P * rl * cov + gcol[c] * sf * (1 - cov));   // ground = BG darkened by shadow
      }
    }
    const buf = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    await writeFile(join(OUTDIR, `${sku}.jpg`), buf);
    console.log(`ok ${sku} → ${OUTDIR}/${sku}.jpg  (relightMean=${mean.toFixed(1)})`);
  } catch (e) {
    console.log(`FAIL ${sku}: ${e.message}`);
  }
}

const cells = [];
for (const sku of skus) {
  const p = join(OUTDIR, `${sku}.jpg`);
  if (!(await exists(p))) continue;
  const img = await sharp(p).resize(560, 560, { fit: "contain", background: `#${BG}` }).flatten({ background: `#${BG}` }).toBuffer();
  const cap = Buffer.from(`<svg width="560" height="26"><rect width="100%" height="100%" fill="black"/><text x="8" y="19" font-family="monospace" font-size="16" fill="white">${sku}</text></svg>`);
  cells.push(await sharp(img).composite([{ input: cap, top: 0, left: 0 }]).png().toBuffer());
}
const cols = 2, cw = 560, rows = Math.ceil(cells.length / cols);
const sheetOut = `outputs/contact_sheet_plush_furedge_shadow${BG === "FFFFFF" ? "" : "_" + BG.toLowerCase()}.jpg`;
await sharp({ create: { width: cols * (cw + 8), height: rows * (cw + 8), channels: 3, background: "#ddd" } })
  .composite(cells.map((c, i) => ({ input: c, left: (i % cols) * (cw + 8), top: Math.floor(i / cols) * (cw + 8) })))
  .jpeg({ quality: 92 }).toFile(sheetOut);
console.log("contact sheet → " + sheetOut);
