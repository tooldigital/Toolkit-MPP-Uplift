// EXPERIMENT — Gemini shadow patching (see src/shadow-patch.mjs).
// Reads the cached shadow.jpg + matte.png from outputs/work/<sku>/ and writes ONLY to
// outputs/experiments/shadow_patch/. The production pipeline is untouched.
//
//   node --env-file=.env scripts/exp_shadow_patch.mjs PE1016720 PE937605

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { improveShadow } from "../src/shadow-patch.mjs";

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const skus = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (skus.length === 0) { console.error("usage: exp_shadow_patch.mjs <sku> [sku...]"); process.exit(1); }

const OUT = "outputs/experiments/shadow_patch";
await mkdir(OUT, { recursive: true });

for (const sku of skus) {
  process.stdout.write(`${sku} ... `);
  try {
    const dir = `outputs/work/${sku}`;
    const shadowBytes = await readFile(join(dir, "shadow.jpg"));
    const matteBytes = await readFile(join(dir, "matte.png"));

    const { patched, before, bbox, crop, size: W } = await improveShadow({ apiKey: K, shadowBytes, matteBytes });

    const raw = { raw: { width: W, height: W, channels: 3 } };
    await sharp(patched, raw).jpeg({ quality: 95 }).toFile(join(OUT, `${sku}_after.jpg`));

    // side-by-side of the SHADOW REGION (before | after) for quick judging
    const pad = 60;
    const rx = Math.max(0, crop.x1 - pad), ry = Math.max(0, crop.y1 - pad);
    const rw = Math.min(W - rx, crop.x2 - crop.x1 + 2 * pad), rh = Math.min(W - ry, crop.y2 - crop.y1 + 2 * pad);
    const ex = { left: rx, top: ry, width: rw, height: rh };
    const half = 640;
    const b = await sharp(before, raw).extract(ex).resize(half, null).png().toBuffer();
    const a = await sharp(patched, raw).extract(ex).resize(half, null).png().toBuffer();
    const bh = (await sharp(b).metadata()).height;
    await sharp({ create: { width: half * 2 + 8, height: bh, channels: 3, background: "#222" } })
      .composite([{ input: b, left: 0, top: 0 }, { input: a, left: half + 8, top: 0 }])
      .jpeg({ quality: 90 }).toFile(join(OUT, `${sku}_sbs.jpg`));

    console.log(`ok  shadow bbox ${bbox.w}x${bbox.h} → ${OUT}/${sku}_{after,sbs}.jpg`);
  } catch (e) {
    console.log("FAIL: " + e.message);
  }
}
