// QC the plush F7F7F7 deliverables (3 versions per SKU in one folder) and build the compare sheet.
// Checks, per final: file present · 4000² native · cast shadow present (darkest ground < 240) ·
// silhouette fringe not blown out to bg (halo guard). Prints a PASS/WARN table and writes the
// 3-column compare sheet outputs/compare_plush_normal_fur_nofur.jpg.  No API calls.
//
// NOTE: the NORMAL otter legitimately has NO shadow (its Photoroom shadow is blank — the reason
// fur/no-fur use the Gemini shadow), so its "NO SHADOW" row is expected, not a regression.
//
//   node scripts/qc_plush_f7f7f7.mjs
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const ALL = "outputs/finals_plush_f7f7f7_all/group_plush";
const BG = "F7F7F7";
const SKUS = [
  { sku: "PE317642", name: "panda" },
  { sku: "PE371748", name: "cat" },
  { sku: "PE964848", name: "orangutan" },
  { sku: "PE936323", name: "otter" },
];
const VERSIONS = [
  { key: "normal", label: "NORMAL pipeline" },
  { key: "furedge", label: "FUR EDGES" },
  { key: "nofur", label: "NO FUR" },
];
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const exists = (p) => readFile(p).then(() => true, () => false);

async function metrics(sku, path) {
  if (!(await exists(path))) return { ok: false };
  const W = 1500;
  const meta = await sharp(path).metadata();
  const matte = await readFile(join("outputs/work", sku, "matte.png"));
  const a = await sharp(matte).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  const img = await sharp(path).resize(W, W).removeAlpha().raw().toBuffer();
  let gmin = 255, fSum = 0, fN = 0;
  for (let p = 0, i = 0; p < W * W; p++, i += 3) {
    const av = a[p] / 255, l = gray(img[i], img[i + 1], img[i + 2]);
    if (av < 0.10) { if (l < gmin) gmin = l; }
    else if (av > 0.05 && av < 0.45) { fSum += l; fN++; }
  }
  return { ok: true, native: meta.width === 4000 && meta.height === 4000, dims: `${meta.width}x${meta.height}`, shadow: gmin, fringe: fN ? fSum / fN : 0 };
}

const rows = [];
let hardFail = false;
for (const v of VERSIONS) {
  for (const { sku, name } of SKUS) {
    const m = await metrics(sku, join(ALL, `${sku}_${v.key}.jpg`));
    const checks = [];
    const normalOtter = v.key === "normal" && sku === "PE936323";  // blank Photoroom shadow — expected
    if (!m.ok) { checks.push("MISSING"); hardFail = true; }
    else {
      if (!m.native) { checks.push(`NOT 4000² (${m.dims})`); hardFail = true; }
      if (m.shadow >= 240 && !normalOtter) { checks.push(`NO SHADOW (ground ${m.shadow.toFixed(0)})`); hardFail = true; }
      if (m.shadow >= 240 && normalOtter) checks.push("no shadow (expected: blank Photoroom)");
      if (m.fringe >= 235) checks.push(`HALO? (fringe ${m.fringe.toFixed(0)})`);
    }
    const verdict = !m.ok ? "FAIL" : checks.some((c) => c.startsWith("NOT") || c.startsWith("NO SHADOW")) ? "FAIL"
      : checks.length ? "WARN" : "PASS";
    rows.push({ v: v.label, name, sku, m, verdict, checks });
  }
}

console.log("\n  version          product     sku        dims       shadow  fringe  verdict");
console.log("  " + "-".repeat(80));
for (const r of rows) {
  const d = r.m.ok ? r.m.dims.padEnd(10) : "-".padEnd(10);
  const sh = r.m.ok ? r.m.shadow.toFixed(0).padStart(6) : "     -";
  const fr = r.m.ok ? r.m.fringe.toFixed(0).padStart(6) : "     -";
  const note = r.checks.length ? "  " + r.checks.join(", ") : "";
  console.log(`  ${r.v.padEnd(16)} ${r.name.padEnd(11)} ${r.sku.padEnd(10)} ${d} ${sh}  ${fr}  ${r.verdict}${note}`);
}
console.log("  " + "-".repeat(80));
console.log(`  shadow: darkest ground pixel, <240 = grounded. fringe: silhouette-edge luma, →${parseInt(BG.slice(0, 2), 16)} = white halo.\n`);

// --- 3-column compare sheet: NORMAL | FUR EDGES | NO FUR, one row per SKU ---
const cw = 520, hh = 28, hw = cw + 8;
async function cell(f, lbl) {
  const img = await sharp(f).resize(cw, cw, { fit: "contain", background: `#${BG}` }).flatten({ background: `#${BG}` }).toBuffer();
  const cap = Buffer.from(`<svg width="${cw}" height="${hh}"><rect width="100%" height="100%" fill="black"/><text x="8" y="20" font-family="monospace" font-size="14" fill="white">${lbl}</text></svg>`);
  return sharp({ create: { width: cw, height: cw + hh, channels: 3, background: `#${BG}` } })
    .composite([{ input: cap, top: 0, left: 0 }, { input: img, top: hh, left: 0 }]).png().toBuffer();
}
const sheetRows = [];
const hdr = Buffer.from(`<svg width="${hw * 3}" height="32"><rect width="100%" height="100%" fill="#222"/>${VERSIONS.map((v, i) => `<text x="${i * hw + cw / 2 - 70}" y="22" font-family="monospace" font-size="18" fill="#fff">${v.label}</text>`).join("")}</svg>`);
sheetRows.push(await sharp(hdr).png().toBuffer());
for (const { sku, name } of SKUS) {
  const cells = [];
  for (const v of VERSIONS) cells.push(await cell(join(ALL, `${sku}_${v.key}.jpg`), `${sku} ${name}`));
  sheetRows.push(await sharp({ create: { width: hw * 3, height: cw + hh, channels: 3, background: "#ddd" } })
    .composite(cells.map((c, i) => ({ input: c, left: i * hw, top: 0 }))).png().toBuffer());
}
const meta = await Promise.all(sheetRows.map((r) => sharp(r).metadata()));
const H = meta.reduce((s, m) => s + m.height + 6, 0);
await sharp({ create: { width: hw * 3, height: H, channels: 3, background: "#ddd" } })
  .composite(sheetRows.map((r, i) => ({ input: r, left: 0, top: meta.slice(0, i).reduce((s, m) => s + m.height + 6, 0) })))
  .jpeg({ quality: 90 }).toFile("outputs/compare_plush_normal_fur_nofur.jpg");
console.log("  compare sheet → outputs/compare_plush_normal_fur_nofur.jpg");
console.log(hardFail ? "  QC: check FAIL rows above\n" : "  QC: PASS (all present, native, grounded; normal-otter shadow expected blank)\n");
process.exit(hardFail ? 1 : 0);
