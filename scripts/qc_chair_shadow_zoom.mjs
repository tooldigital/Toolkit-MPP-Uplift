// Rogue-shadow zoom sheet.
//
//   node scripts/qc_chair_shadow_zoom.mjs [--group group_chair] [--np] [--hd]
//     [--finals outputs/finals_chair_f7f7f7_hd_noplate] [--out outputs/qc_chair_shadow_zoom.jpg]
//
// Photoroom's generateShadow is non-deterministic (CLAUDE.md invariant 4): on legged furniture an
// individual leg's cast occasionally goes the WRONG WAY — usually the far/back-right leg, whose
// shadow should run right-and-back with the others but instead points left or forward.
//
// Per SKU this crops the GROUND BAND — the bottom third of the product plus the floor to its right
// and below, where the `long` preset (direction: behindRight) puts the cast — as shipped, no
// tone changes, so the tiles read the way the finals actually look.
//
// `--boost` adds a second tile per SKU with the near-white range stretched (200-250 -> 0-255). It
// exaggerates a cast that sits ~20 levels under an F7F7F7 floor, and blows out the product doing it
// — off by default; turn it on only when a shadow is too faint to judge by eye.
//
// No API calls — reads the cached matte (for the product bbox) + the shipped finals. The bbox drives
// the crop, so SKUs framed at different scales (no-plate) still get comparable views.

import { readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import sharp from "sharp";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const GROUP = arg("--group", "group_chair");
const FINALS = arg("--finals", "outputs/finals_chair_f7f7f7_hd_noplate");
const OUT = arg("--out", "outputs/qc_chair_shadow_zoom.jpg");
// Which cached matte variant to read the bbox from — must match how the finals were rendered.
const SUF = `${process.argv.includes("--np") ? "_np" : ""}${process.argv.includes("--hd") ? "_hd" : ""}`;

const BOOST = process.argv.includes("--boost");
const TW = 620, TH = 420;        // sub-tile size (the crop is ~3:2 landscape)
const LBL = 22;
const PER_ROW = BOOST ? 2 : 3;   // SKUs per row (each is 2 tiles wide under --boost)
// Crop geometry, as fractions of the product bbox: how much of the product's height to keep above
// its baseline, and how far past the bbox to reach for the cast.
const UP = 0.34, DOWN = 0.16, LEFT = 0.06, RIGHT = 0.34;
// Contrast stretch for the shadow twin: map 200 -> 0 and 250 -> 255.
const LO = 200, HI = 250;
const A = 255 / (HI - LO), B = -LO * A;

const files = (await readdir(join("inputs", GROUP))).filter((f) => /\.jpe?g$/i.test(f)).sort();
const skus = files.map((f) => f.replace(/\.jpe?g$/i, ""));

const tiles = [];
for (const sku of skus) {
  const { data, info } = await sharp(join("outputs/work", sku, `matte${SUF}.png`))
    .ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[y * info.width + x] > 25) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const left = Math.max(0, Math.round(x0 - LEFT * w));
  const top = Math.max(0, Math.round(y1 - UP * h));
  const width = Math.min(info.width - left, Math.round(w * (1 + LEFT + RIGHT)));
  const height = Math.min(info.height - top, Math.round(h * (UP + DOWN)));
  const crop = sharp(join(FINALS, GROUP, `${sku}.jpg`)).extract({ left, top, width, height });
  const plain = await crop.clone().resize(TW, TH, { fit: "fill" }).jpeg({ quality: 92 }).toBuffer();
  const boost = BOOST
    ? await crop.clone().resize(TW, TH, { fit: "fill" }).linear(A, B).jpeg({ quality: 92 }).toBuffer()
    : null;
  tiles.push({ sku, plain, boost });
  console.log(`${sku}  product ${w}x${h}  band ${width}x${height} @ ${left},${top}`);
}

const SPAN = BOOST ? TW * 2 : TW;   // width one SKU occupies
const rows = Math.ceil(tiles.length / PER_ROW);
const comps = [];
tiles.forEach((t, i) => {
  const cx = (i % PER_ROW) * SPAN, cy = Math.floor(i / PER_ROW) * (TH + LBL);
  comps.push({ input: t.plain, left: cx, top: cy + LBL });
  if (t.boost) comps.push({ input: t.boost, left: cx + TW, top: cy + LBL });
  const tag = BOOST ? `<text x="${TW + 7}" y="16" font-size="13" font-family="monospace" fill="#7fd">contrast x${A.toFixed(1)}</text>` : "";
  comps.push({
    input: Buffer.from(`<svg width="${SPAN}" height="${LBL}"><rect width="${SPAN}" height="${LBL}" fill="#111"/><text x="7" y="16" font-size="13" font-family="monospace" fill="#eee">${t.sku}</text>${tag}</svg>`),
    left: cx, top: cy,
  });
});

await mkdir(dirname(OUT), { recursive: true });
await sharp({ create: { width: PER_ROW * SPAN, height: rows * (TH + LBL), channels: 3, background: "#000" } })
  .composite(comps).jpeg({ quality: 92 }).toFile(OUT);
console.log(`\n${tiles.length} SKUs → ${OUT}`);
