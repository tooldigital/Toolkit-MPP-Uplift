// EXPERIMENT — everything off. Two layers only:
//   background = Photoroom shadow render (base, = product-on-white + cast shadow)
//   object     = crisp removeBackground cutout (matte), composited straight on top by its alpha
//   out = subj*A + base*(1-A)     (no relight, no smoothstep, no bg recolor)
// Reuses cached matte.png + shadow.jpg. No API calls. Writes only to outputs/experiments/.
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const W = 4000;
const SKUS = ["PE842382", "PE962684", "PE988680", "PE988681"];
const WORK = "outputs/work";
const OUT = "outputs/experiments/glass_shadow_plus_object";
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

await mkdir(OUT, { recursive: true });
const cells = [];
for (const sku of SKUS) {
  const subj  = await sharp(join(WORK, sku, "matte.png")).resize(W, W).removeAlpha().raw().toBuffer();
  const alpha = await sharp(join(WORK, sku, "matte.png")).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  const base  = await sharp(join(WORK, sku, "shadow.jpg")).resize(W, W).removeAlpha().raw().toBuffer();

  const out = Buffer.alloc(W * W * 3);
  for (let p = 0, i = 0; p < alpha.length; p++, i += 3) {
    const a = alpha[p] / 255;                 // object cutout over the shadow render
    out[i]     = clamp(subj[i]     * a + base[i]     * (1 - a));
    out[i + 1] = clamp(subj[i + 1] * a + base[i + 1] * (1 - a));
    out[i + 2] = clamp(subj[i + 2] * a + base[i + 2] * (1 - a));
  }
  const path = join(OUT, `${sku}.jpg`);
  await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toFile(path);
  console.log("wrote", path);

  const C = 480, L = 24;
  const img = await sharp(path).resize(C, C, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).toBuffer();
  const lbl = await sharp({ text: { text: sku, font: "sans", rgba: true, width: C, height: L } }).png().toBuffer();
  cells.push(await sharp({ create: { width: C, height: C + L, channels: 3, background: "#000" } })
    .composite([{ input: img, top: L, left: 0 }, { input: lbl, top: 2, left: 4 }]).png().toBuffer());
}
const C = 480, L = 24;
await sharp({ create: { width: C * SKUS.length, height: C + L, channels: 3, background: "#000" } })
  .composite(cells.map((c, i) => ({ input: c, left: i * C, top: 0 }))).jpeg({ quality: 90 })
  .toFile(join(OUT, "contact_sheet.jpg"));
console.log("contact sheet →", join(OUT, "contact_sheet.jpg"));
