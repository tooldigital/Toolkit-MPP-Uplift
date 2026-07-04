// EXPERIMENT (not part of the production pipeline).
// One-shot lighting + shadow via Gemini at temperature 0, using the reference image.
// Goal: see if Gemini gives consistent (esp. multi-leg) shadows deterministically, so we
// avoid Photoroom's per-leg direction lottery. Outputs to outputs/experiments/gemini_scene_v2/.
//
//   node --env-file=.env scripts/exp_gemini_scene.mjs PE1016720 PE735706 [--runs 2]
//
// Does NOT touch outputs/finals or the production flow.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makePlate, composeBackground } from "../src/plate.mjs";
import { generateShadowGemini } from "../src/gemini.mjs";

// Revised one-shot instruction: explicit back-right cast shadow + pure flat white background
// (to suppress the 4K empty-canvas tiling), product kept identical.
const INSTRUCTION = `Relight the product in the first image to match the soft, even studio lighting of the reference (second image): a gentle front-left key light.

Add ONE soft, neutral grey cast shadow on the floor, falling to the BACK-RIGHT of the product (behind it and to the right). Every part of the product must cast its shadow in this same direction — consistent, never splayed in different directions.

The background must be PURE FLAT WHITE (#FFFFFF): perfectly clean and uniform, no texture, no gradients, no patterns, no tiles, no noise.

Keep the product PIXEL-IDENTICAL: same shape, colour, texture, logos, and the EXACT same position and scale. Do not redraw or restyle it.`;

const K = process.env.GEMINI_KEY;
if (!K) { console.error("Set GEMINI_KEY"); process.exit(1); }
const args = process.argv.slice(2);
const ri = args.indexOf("--runs");
const RUNS = ri >= 0 ? parseInt(args[ri + 1]) : 2;
const skus = args.filter((a, i) => !a.startsWith("--") && !(ri >= 0 && i === ri + 1));

const REF = "refs/correct_lighting_and_shadow.png";
const OUT = "outputs/experiments/gemini_scene_v2";
await mkdir(OUT, { recursive: true });

for (const sku of skus) {
  const { plate } = await makePlate({ source: `inputs/${sku}.jpg` });
  const plateWhite = await composeBackground(plate, "FFFFFF");
  for (let r = 0; r < RUNS; r++) {
    process.stdout.write(`${sku} run${r + 1}/${RUNS} ... `);
    try {
      const bytes = await generateShadowGemini({
        apiKey: K, image: plateWhite, reference: REF,
        instruction: INSTRUCTION, temperature: 0, filename: `${sku}.png`,
      });
      await writeFile(join(OUT, `${sku}_run${r + 1}.jpg`), Buffer.from(bytes));
      console.log("ok");
    } catch (e) { console.log("FAIL: " + e.message); }
  }
}
console.log(`\nDone → ${OUT}/`);
