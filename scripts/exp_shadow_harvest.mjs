// EXPERIMENT — Gemini shadow HARVEST (see src/shadow-patch.mjs, mode B).
// Full-scene Gemini adds lighting+shadow to the shadowless product; we keep only the
// shadow and composite our real product pixels back. Writes ONLY to
// outputs/experiments/shadow_harvest/. Production pipeline untouched.
//
//   node --env-file=.env scripts/exp_shadow_harvest.mjs PE1016720 PE937605

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { harvestShadow } from "../src/shadow-patch.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (skus.length === 0) { console.error("usage: exp_shadow_harvest.mjs <sku> [sku...]"); process.exit(1); }

const OUT = "outputs/experiments/shadow_harvest";
await mkdir(OUT, { recursive: true });

for (const sku of skus) {
  process.stdout.write(`${sku} ... `);
  try {
    const matteBytes = await readFile(join(`outputs/work/${sku}`, "matte.png"));
    const { withShadow, gen, size: W } = await harvestShadow({ apiKey: K, matteBytes });
    const raw = { raw: { width: W, height: W, channels: 3 } };
    await sharp(withShadow, raw).jpeg({ quality: 95 }).toFile(join(OUT, `${sku}_harvest.jpg`));
    await sharp(gen).jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_gen.jpg`));

    // side-by-side vs the Photoroom shadow base (before | harvest)
    const before = await sharp(join(`outputs/work/${sku}`, "shadow.jpg")).resize(900, 900).png().toBuffer();
    const after = await sharp(withShadow, raw).resize(900, 900).png().toBuffer();
    await sharp({ create: { width: 1808, height: 900, channels: 3, background: "#222" } })
      .composite([{ input: before, left: 0, top: 0 }, { input: after, left: 908, top: 0 }])
      .jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_sbs.jpg`));
    console.log(`ok → ${OUT}/${sku}_{harvest,gen,sbs}.jpg`);
  } catch (e) {
    console.log("FAIL: " + e.message);
  }
}
