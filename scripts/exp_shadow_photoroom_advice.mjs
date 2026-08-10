// EXPERIMENT — test Photoroom support's two suggestions on the exact bug-report plates.
//
// Issue 1 (PE1016720, yellow armchair): one leg's shadow disagrees with the other three under
//   shadow.directionOverride=behindRight. Photoroom: "override directionOverride with a NUMBER
//   0–360; nudging it off the behindRight preset may fix it. spreadOverride can also help."
//   → sweep direction numerically around behindRight, then sweep spread at fixed direction.
//
// Issue 2 (PE936323, plush otter lying flat): detached blob under the head only. Photoroom:
//   "that's shadow.poseOverride — REMOVE the argument (auto), or give a number 0–90."
//   → variant with subjectPose omitted entirely, plus numeric 0 / 45 / 90.
//
// Uses the plates already committed under outputs/photoroom_bugreport/ so this reproduces the
// reported calls byte-for-byte apart from the swept param. Writes ONLY to
// outputs/experiments/shadow_advice/ — nothing here is wired into the pipeline.
//
//   node --env-file=.env scripts/exp_shadow_photoroom_advice.mjs            # both issues
//   node --env-file=.env scripts/exp_shadow_photoroom_advice.mjs --issue 1  # one issue
//   node --env-file=.env scripts/exp_shadow_photoroom_advice.mjs --force    # ignore cached variants
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateShadow } from "../src/photoroom.mjs";

const prKey = process.env.PHOTOROOM_KEY;
if (!prKey) { console.error("Set PHOTOROOM_KEY (in .env)"); process.exit(1); }
const argv = process.argv.slice(2);
const FORCE = argv.includes("--force");
const ONLY = argv.includes("--issue") ? argv[argv.indexOf("--issue") + 1] : null;

const OUT = "outputs/experiments/shadow_advice";
const BUG = "outputs/photoroom_bugreport";
const exists = (p) => stat(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The reported call, minus whatever the variant overrides.
const BASE = { softness: 0.6, intensity: 0.55, spread: "long", direction: "behindRight", subjectPose: "upright" };

const ISSUES = [
  {
    id: "1",
    sku: "PE1016720",
    plate: join(BUG, "issue1_shadow_wrong_leg", "input_PE1016720_plate.png"),
    note: "armchair — one leg's shadow disagrees. sweep numeric direction, then spread.",
    variants: [
      { name: "baseline_behindRight", shadow: {} },
      // behindRight as a number, then ±nudges. Photoroom's angle convention isn't documented, so
      // this walks the whole back-right quadrant in 15° steps and lets the sheet show which is which.
      ...[300, 315, 330, 345, 0, 15, 30, 45].map((d) => ({ name: `dir_${d}`, shadow: { direction: d } })),
      // spread as the second lever, held at the preset direction.
      ...["short", "medium", 20, 60].map((s) => ({ name: `spread_${s}`, shadow: { spread: s } })),
    ],
  },
  {
    // PASS 2 — pass 1 showed the missing back-right leg shadow tracks SPREAD, not direction: every
    // numeric direction failed at spread=long, every shorter spread fixed it. But long is the look we
    // want, and `3_long_grounded` (spread long, NO direction, intensity 0.5 / softness 0.75) was the
    // best result of the earlier exp_shadow_paramsweep run. So: hold spread=long and the GROUNDED
    // intensity/softness, and reintroduce a back-right direction on top — testing whether the softer/
    // lighter shadow keeps the back-right leg that the 0.55/0.6 pass-1 settings dropped.
    id: "1b",
    sku: "PE1016720",
    plate: join(BUG, "issue1_shadow_wrong_leg", "input_PE1016720_plate.png"),
    note: "armchair — spread=long + grounded intensity/softness, sweeping direction back in.",
    // grounded tone from exp_shadow_paramsweep's winning variant, overriding pass 1's BASE
    base: { softness: 0.75, intensity: 0.5, spread: "long", subjectPose: "upright" },
    variants: [
      { name: "long_grounded", shadow: { direction: null } },        // the reference (no direction)
      { name: "long_behind", shadow: { direction: "behind" } },
      { name: "long_behindRight", shadow: { direction: "behindRight" } },
      ...[300, 315, 330, 345].map((d) => ({ name: `long_dir_${d}`, shadow: { direction: d } })),
      // isolate tone from geometry: same behindRight+long, but pass 1's harder 0.55/0.6.
      { name: "long_behindRight_hard", shadow: { direction: "behindRight", intensity: 0.55, softness: 0.6 } },
    ],
  },
  {
    id: "2",
    sku: "PE936323",
    plate: join(BUG, "issue2_shadow_wrong", "input_PE936323_plate.png"),
    note: "plush otter flat — detached head-only blob. drop subjectPose (auto) / numeric pose.",
    variants: [
      { name: "baseline_upright", shadow: {} },
      { name: "pose_auto_omitted", shadow: { subjectPose: null } },   // null → field not sent
      ...[0, 45, 90].map((p) => ({ name: `pose_${p}`, shadow: { subjectPose: p } })),
      // pose=auto is the fix Photoroom named; pair it with no direction override too, since a
      // flatlay subject + a hard behindRight cast is the other half of the reported look.
      { name: "pose_auto_dir_auto", shadow: { subjectPose: null, direction: null } },
    ],
  },
];

for (const issue of ISSUES) {
  if (ONLY && ONLY !== issue.id) continue;
  const dir = join(OUT, `issue${issue.id}_${issue.sku}`);
  await mkdir(dir, { recursive: true });
  console.log(`\n=== issue ${issue.id} — ${issue.sku}: ${issue.note}`);
  const plate = await readFile(issue.plate);

  const made = [];
  for (const v of issue.variants) {
    const path = join(dir, `${v.name}.jpg`);
    if (!FORCE && await exists(path)) { console.log(`  ${v.name.padEnd(22)} cached`); made.push({ ...v, path }); continue; }
    // undefined merges away; an explicit null in the variant WINS and suppresses the field,
    // because generateShadow only appends params that are != null.
    const shadow = { mode: "ai.auto-with-overrides", ...(issue.base ?? BASE), ...v.shadow };
    const t = Date.now();
    const bytes = await generateShadow({
      apiKey: prKey, image: plate, filename: `${issue.sku}.png`, sku: issue.sku,
      shadow, background: "FFFFFF", outputSize: "4000x4000", padding: 0.10, format: "jpeg",
    });
    await writeFile(path, bytes);
    console.log(`  ${v.name.padEnd(22)} ${((Date.now() - t) / 1000).toFixed(1)}s  ${(bytes.length / 1e6).toFixed(1)}MB`);
    made.push({ ...v, path });
    await sleep(1200);   // sandbox keys are 60/min
  }

  // contact sheet — 4 per row, labelled
  const CELL = 620, COLS = 4, PAD = 8, LBL = 34;
  const rows = Math.ceil(made.length / COLS);
  const cells = await Promise.all(made.map(async (m) => ({
    name: m.name,
    buf: await sharp(m.path).resize(CELL, CELL, { fit: "contain", background: "#ffffff" }).toBuffer(),
  })));
  const sheetW = COLS * CELL + (COLS + 1) * PAD;
  const sheetH = rows * (CELL + LBL) + (rows + 1) * PAD;
  const comps = [];
  cells.forEach((c, i) => {
    const cx = PAD + (i % COLS) * (CELL + PAD);
    const cy = PAD + Math.floor(i / COLS) * (CELL + LBL + PAD);
    comps.push({ input: c.buf, left: cx, top: cy });
    comps.push({
      input: Buffer.from(
        `<svg width="${CELL}" height="${LBL}"><rect width="100%" height="100%" fill="#fff"/>` +
        `<text x="4" y="24" font-family="monospace" font-size="22" fill="#111">${c.name}</text></svg>`),
      left: cx, top: cy + CELL,
    });
  });
  const sheet = join(OUT, `sheet_issue${issue.id}_${issue.sku}.jpg`);
  await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: "#dddddd" } })
    .composite(comps).jpeg({ quality: 92 }).toFile(sheet);
  console.log(`  → ${sheet}`);
}
