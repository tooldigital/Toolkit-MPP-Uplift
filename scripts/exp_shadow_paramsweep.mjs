// EXPERIMENT — decouple shadow LENGTH (spread) from shadow OFFSET (direction).
//
// The white-line rim came from the `long` preset's directionOverride:behindRight, which pushes the
// shadow off to the side and leaves bright un-shadowed floor at the front contour. Length itself
// (spread) is a SEPARATE param. This sweeps combos on the panda (worst case) to find a shadow that
// is long/dramatic AND grounded (no rim): vary `spread` (short|medium|long or numeric 0–90) while
// keeping direction OFF (grounded) vs a straight `behind`.
//
// Reuses the cached HD matte; only fetches the shadow variants. Writes to outputs/experiments/shadow_sweep/.
//   node --env-file=.env scripts/exp_shadow_paramsweep.mjs

import { mkdir, readFile, writeFile, copyFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const ENDPOINT = "https://image-api.photoroom.com/v2/edit";
const MV = "2026-04-15";
const W = 4000, BG = "F7F7F7";
const argv = process.argv.slice(2);
const SKU = argv.find((a) => /^PE\d+$/.test(a)) || "PE317642";
const prKey = process.env.PHOTOROOM_KEY;
if (!prKey) { console.error("Set PHOTOROOM_KEY"); process.exit(1); }

// locate <SKU>.(jpg|png|webp) anywhere under inputs/
async function findInput(root, sku) {
  for (const e of await readdir(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) { const hit = await findInput(p, sku); if (hit) return hit; }
    else if (new RegExp(`^${sku}\\.(jpe?g|png|webp)$`, "i").test(e.name)) return p;
  }
  return null;
}
const SRC_PATH = await findInput("inputs", SKU);
if (!SRC_PATH) { console.error(`input for ${SKU} not found under inputs/`); process.exit(1); }
console.log(`SKU ${SKU} ← ${SRC_PATH}`);

const OUT = "outputs/experiments/shadow_sweep";
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => stat(p).then(() => true, () => false);

// label → shadow overrides. direction omitted = grounded (no lateral offset).
const VARIANTS = [
  { k: "1_short_grounded",   spread: "short",  intensity: "0.5",  softness: "0.75" },
  { k: "2_medium_grounded",  spread: "medium", intensity: "0.5",  softness: "0.75" },
  { k: "3_long_grounded",    spread: "long",   intensity: "0.5",  softness: "0.75" },   // long length, NO direction
  { k: "4_spread60_grounded",spread: "60",     intensity: "0.5",  softness: "0.75" },   // numeric length
  { k: "5_long_behind",      spread: "long",   intensity: "0.5",  softness: "0.75", direction: "behind" }, // straight back
  { k: "6_long_behindRight", spread: "long",   intensity: "0.55", softness: "0.6",  direction: "behindRight" }, // the RIM baseline
];

async function edit(v) {
  const buf = await readFile(SRC_PATH);
  const fd = new FormData();
  fd.append("imageFile", new Blob([buf]), SRC_PATH.split("/").pop());
  fd.append("referenceBox", "originalImage");
  fd.append("outputSize", `${W}x${W}`); fd.append("padding", "0.10");
  fd.append("removeBackground", "true");
  fd.append("shadow.mode", "ai.auto-with-overrides");
  fd.append("shadow.softnessOverride", v.softness);
  fd.append("shadow.intensityOverride", v.intensity);
  fd.append("shadow.spreadOverride", v.spread);
  if (v.direction) fd.append("shadow.directionOverride", v.direction);
  fd.append("shadow.subjectPoseOverride", "upright");
  fd.append("background.color", "FFFFFF");
  fd.append("export.format", "jpeg");
  const res = await fetch(ENDPOINT, { method: "POST", headers: { "x-api-key": prKey, "pr-ai-shadows-model-version": MV }, body: fd });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => "")}`);
  return Buffer.from(new Uint8Array(await res.arrayBuffer()));
}

await mkdir(OUT, { recursive: true });
const bgR = parseInt(BG.slice(0, 2), 16), bgG = parseInt(BG.slice(2, 4), 16), bgB = parseInt(BG.slice(4, 6), 16);

// HD matte — reuse from a prior experiment if present, else fetch (no-plate + HD).
async function editMatte() {
  const buf = await readFile(SRC_PATH);
  const fd = new FormData();
  fd.append("imageFile", new Blob([buf]), SRC_PATH.split("/").pop());
  fd.append("referenceBox", "originalImage");
  fd.append("outputSize", `${W}x${W}`); fd.append("padding", "0.10");
  fd.append("removeBackground", "true");
  fd.append("export.format", "png");
  const res = await fetch(ENDPOINT, { method: "POST", headers: { "x-api-key": prKey, "pr-hd-background-removal": "auto" }, body: fd });
  if (!res.ok) throw new Error(`matte ${res.status}: ${await res.text().catch(() => "")}`);
  return Buffer.from(new Uint8Array(await res.arrayBuffer()));
}
const mattePath = join(OUT, `${SKU}_matte_hd.png`);
if (!await exists(mattePath)) {
  let seeded = false;
  for (const seed of [`outputs/experiments/plush_shortlong_noplate_hd/${SKU}_matte_hd.png`, `outputs/experiments/referencebox/${SKU}_matte_hd.png`]) {
    if (await exists(seed)) { await copyFile(seed, mattePath); seeded = true; break; }
  }
  if (!seeded) { process.stdout.write("fetch HD matte ... "); await writeFile(mattePath, await editMatte()); console.log("ok"); await sleep(1200); }
}
const matteBytes = await readFile(mattePath);
const subj = await sharp(matteBytes).resize(W, W).removeAlpha().raw().toBuffer();
const A = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();

function comp(base) {
  const o = Buffer.alloc(W * W * 3);
  for (let p = 0, i = 0; p < W * W; p++, i += 3) {
    const a = A[p] / 255, L = gray(base[i], base[i + 1], base[i + 2]);
    const sf = (a * 255 + (1 - a) * L) / 255;
    o[i] = clamp(subj[i] * a + bgR * sf * (1 - a));
    o[i + 1] = clamp(subj[i + 1] * a + bgG * sf * (1 - a));
    o[i + 2] = clamp(subj[i + 2] * a + bgB * sf * (1 - a));
  }
  return o;
}

const seedShadow = { "1_short_grounded": `outputs/experiments/plush_shortlong_noplate_hd/${SKU}_shadow_short.jpg`,
                     "6_long_behindRight": `outputs/experiments/plush_shortlong_noplate_hd/${SKU}_shadow_long.jpg` };
const finals = [];
for (const v of VARIANTS) {
  const sp = join(OUT, `${SKU}_shadow_${v.k}.jpg`);
  let base;
  if (await exists(sp)) base = await readFile(sp);
  else if (seedShadow[v.k] && await exists(seedShadow[v.k])) { await copyFile(seedShadow[v.k], sp); base = await readFile(sp); }
  else { process.stdout.write(`fetch ${v.k} ... `); base = await edit(v); await writeFile(sp, base); console.log("ok"); await sleep(1200); }
  const raw = await sharp(base).resize(W, W).removeAlpha().raw().toBuffer();
  const buf = await sharp(comp(raw), { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  await writeFile(join(OUT, `${SKU}_${v.k}.jpg`), buf);
  finals.push({ k: v.k, buf });
}

// sheet: full (top) + ground-contact crop (bottom) per variant, in a grid.
// per-SKU crop where known; else a wide bottom band that catches feet/legs + their shadow.
const FEET = {
  PE317642: { left: 1150, top: 2650, width: 1500, height: 900 },
  PE1016720:{ left: 550,  top: 2450, width: 3050, height: 900 },    // armchair: full leg region (legs start ~y2620) + ground contact + shadow
};
const feet = FEET[SKU] || { left: 300, top: 2850, width: 3400, height: 1050 };
const C = 620, FW = 620, FH = Math.round(FW * feet.height / feet.width), Lh = 26;
const label = (t, w) => Buffer.from(`<svg width="${w}" height="${Lh}"><rect width="100%" height="100%" fill="black"/><text x="6" y="19" font-family="monospace" font-size="15" fill="#8f8">${t}</text></svg>`);
const cells = [];
for (const { k, buf } of finals) {
  const full = await sharp(buf).resize(C, C, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).toBuffer();
  const crop = await sharp(buf).extract(feet).resize(FW, FH, { fit: "fill" }).toBuffer();
  cells.push(await sharp({ create: { width: C, height: Lh + C + FH, channels: 3, background: "#fff" } })
    .composite([{ input: label(k, C), top: 0, left: 0 }, { input: full, top: Lh, left: 0 }, { input: crop, top: Lh + C, left: 0 }]).png().toBuffer());
}
const COLS = 3, ROWS = Math.ceil(cells.length / COLS), CH = Lh + C + FH;
await sharp({ create: { width: C * COLS, height: CH * ROWS, channels: 3, background: "#222" } })
  .composite(cells.map((c, i) => ({ input: c, left: (i % COLS) * C, top: Math.floor(i / COLS) * CH }))).jpeg({ quality: 92 })
  .toFile(join(OUT, `${SKU}_sweep_sheet.jpg`));
console.log(`\nsheet → ${OUT}/${SKU}_sweep_sheet.jpg  (top=full, bottom=feet/legs crop)`);
