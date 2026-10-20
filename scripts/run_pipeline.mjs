// MPP uplift pipeline — one SKU at a time, cached, resumable.
//
//   node --env-file=.env scripts/run_pipeline.mjs [--skus a,b] [--group g] [flags]
//
// Per SKU: plate → Photoroom shadow render → Photoroom matte → Gemini lighting map → composite.
// Behaviour and maths: docs/pipeline.md. Every flag, group.json key and cache file name:
// docs/configuration.md. Why each constant has its value: docs/decisions.md.

import { mkdir, readdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import sharp from "sharp";
import { makePlate, composeBackground, squarePlate } from "../src/plate.mjs";
import { cutout } from "../src/cutout.mjs";
import { generateShadow } from "../src/photoroom.mjs";
import { generateShadowGemini, RELIGHT_VARIANTS } from "../src/gemini.mjs";
import { initDebug, logEvent } from "../src/debuglog.mjs";

// ---------------------------------------------------------------------------------------------
// CLI
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const NO_RELIGHT = flag("--no-relight");          // skip Gemini; GEMINI_KEY not needed
const RELIGHT = flag("--relight");                // force relight on for a group that defaults it off
const NO_CACHE = flag("--no-cache");              // ignore every cached stage (still writes new ones)
const DEBUG = flag("--debug");                    // JSONL log of every request/response + stage images
const HD = !flag("--no-hd");                      // HD background removal is the default (decisions #14)
const NO_PLATE = flag("--no-plate");              // send the raw source; Photoroom frames via referenceBox
const SRC = "inputs", WORK = "outputs/work", W = 4000;
const FINALS = arg("--out", "outputs/finals");
const SHEET = arg("--sheet", "outputs/contact_sheet.jpg");
const prKey = process.env.PHOTOROOM_KEY, gemKey = process.env.GEMINI_KEY;
if (!prKey || (!gemKey && !NO_RELIGHT)) { console.error("Set PHOTOROOM_KEY and GEMINI_KEY (in .env)."); process.exit(1); }

// Settings a group can set; CLI holds only the flags actually passed (undefined = fall through).
const CLI = {
  bg: flag("--bg") ? arg("--bg").toUpperCase() : undefined,
  strength: flag("--strength") ? parseFloat(arg("--strength")) : undefined,
  shadow: flag("--shadow") ? arg("--shadow") : undefined,
  subjectPose: flag("--subject-pose") ? arg("--subject-pose") : undefined,
  relight: NO_RELIGHT ? false : RELIGHT ? true : undefined,
  mode: arg("--mode", null) || (flag("--render-only") ? "render-only" : flag("--transparent") ? "transparent" : undefined),
  highlights: arg("--highlights", null) || (flag("--shade-only") ? "off" : undefined),
  exposure: flag("--exposure") ? parseFloat(arg("--exposure")) : undefined,
  shade: flag("--shade") ? parseFloat(arg("--shade")) : undefined,
};

// ---------------------------------------------------------------------------------------------
// Constants. Each value was measured; the history is in docs/decisions.md (numbers in brackets).
// Photoroom pads its referenceBox: plated → plain fraction of the output; no-plate → fraction of the
// whole source image, calibrated on sources that fill ~96% of their frame [#10, #13].
const PADDING = NO_PLATE ? 0.0838 : 0.10;
const REFBOX = NO_PLATE ? "originalImage" : undefined;
const PLATE_SUF = NO_PLATE ? "_np" : "", HD_SUF = HD ? "_hd" : "";
const SHADOW_PRESETS = {
  long: { mode: "ai.auto-with-overrides", softness: 0.6, intensity: 0.55, spread: "long", direction: "behindRight" },
  short: { mode: "ai.auto-with-overrides", softness: 0.75, intensity: 0.5, spread: "short" },
};
const SUBJECT_POSES = ["upright", "flatlay"];     // flatlay: thin contact shadow for top-down items [#15]
const KNEE = 236;                                  // highlight shoulder knee [#11, #16]
const HEAD_FLOOR = 5, HEAD_RANGE = 25, EDGE_BAND = 3; // highlights:auto headroom measurement [#11]
const PHOTOROOM_PAUSE_MS = 1100;                   // between Photoroom calls (sandbox limit 60/min)

// ---------------------------------------------------------------------------------------------
// Pixel helpers
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// Roll highlights off instead of clipping: identity below KNEE, asymptotic to 255, monotonic.
const shoulder = (v) => (v <= KNEE ? (v < 0 ? 0 : v) : 255 - (255 - KNEE) * Math.exp(-(v - KNEE) / (255 - KNEE)));
// Relight factor from the normalised lightmap deviation d: dark half scaled by `shade`, bright half by `up`.
const relightFactor = (d, up, st) => 1 + (d < 0 ? d * st.shade : d * up) * st.strength;

// highlights:"auto" — how much of the bright half this product can take, 0..1, from the p90 of its
// max channel over the body and over a 3 px edge band (the smaller wins; rim light runs hotter).
function headroomScale(rgb, alpha) {
  const N = Math.round(Math.sqrt(alpha.length));
  const body = [], edge = [];
  for (let y = EDGE_BAND; y < N - EDGE_BAND; y++) for (let x = EDGE_BAND; x < N - EDGE_BAND; x++) {
    const p = y * N + x;
    if (alpha[p] < 200) continue;
    const i = p * 3, v = Math.max(rgb[i], rgb[i + 1], rgb[i + 2]);
    body.push(v);
    if (alpha[p - EDGE_BAND] < 200 || alpha[p + EDGE_BAND] < 200 ||
        alpha[p - EDGE_BAND * N] < 200 || alpha[p + EDGE_BAND * N] < 200) edge.push(v);
  }
  if (!body.length) return 1;
  const scale = (arr) => { arr.sort((a, b) => a - b); const p90 = arr[Math.floor(0.9 * (arr.length - 1))]; return Math.max(0, Math.min(1, (255 - p90 - HEAD_FLOOR) / HEAD_RANGE)); };
  return edge.length ? Math.min(scale(body), scale(edge)) : scale(body);
}

// Lighting map: Gemini output → 4000², blur σ20, luma. Never pixels (invariant 3).
async function lightmapFrom(relitBytes) {
  const g = await sharp(relitBytes).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
  const lm = new Float32Array(W * W);
  for (let p = 0, k = 0; p < lm.length; p++, k += 3) lm[p] = gray(g[k], g[k + 1], g[k + 2]);
  return lm;
}
function alphaWeightedMean(lm, alpha) {
  let gs = 0, aw = 0;
  for (let p = 0; p < lm.length; p++) { const a = alpha[p] / 255; gs += lm[p] * a; aw += a; }
  return aw > 0 ? gs / aw : 128;
}
const rawRGB = (bytes) => sharp(Buffer.from(bytes)).resize(W, W).removeAlpha().raw().toBuffer();
const rawAlpha = (bytes) => sharp(bytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
const toJpeg = (rgb) => sharp(rgb, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();

// ---------------------------------------------------------------------------------------------
// Inputs and per-group settings (CLI flag > inputs/<group>/group.json > default). Validated up front.
const exists = (p) => stat(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectInputs(root, base = "") {
  const out = [];
  for (const e of (await readdir(join(root, base), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? join(base, e.name) : e.name;
    if (e.isDirectory()) out.push(...await collectInputs(root, rel));
    else if (/\.(jpe?g|png|webp)$/i.test(e.name)) out.push(rel);
  }
  return out;
}
const groupCfgCache = new Map();
async function groupConfig(cat) {
  if (cat === ".") return {};
  const top = cat.split("/")[0];
  if (!groupCfgCache.has(top)) {
    let cfg = {};
    try { cfg = JSON.parse(await readFile(join(SRC, top, "group.json"), "utf8")); }
    catch (e) { if (e.code !== "ENOENT") throw new Error(`bad ${top}/group.json: ${e.message}`); }
    groupCfgCache.set(top, cfg);
  }
  return groupCfgCache.get(top);
}
async function resolveSettings(cat) {
  const gc = await groupConfig(cat);
  const mode = CLI.mode ?? gc.mode ?? "opaque";
  const strength = CLI.strength ?? gc.strength ?? 0.25;
  const bg = String(CLI.bg ?? gc.bg ?? "FFFFFF").toUpperCase();
  const shadowName = CLI.shadow ?? gc.shadow ?? "long";
  const subjectPose = CLI.subjectPose ?? gc.subjectPose ?? "upright";
  const relight = CLI.relight ?? gc.relight ?? true;
  const highlights = CLI.highlights ?? gc.highlights ?? (gc.shadeOnly ? "off" : "on");   // shadeOnly: legacy key
  const exposure = CLI.exposure ?? gc.exposure ?? 1;
  const shade = CLI.shade ?? gc.shade ?? 1;
  const bad = (what, allowed) => new Error(`${cat}: bad ${what} (${allowed})`);
  if (!SUBJECT_POSES.includes(subjectPose)) throw bad(`subjectPose "${subjectPose}"`, "upright|flatlay");
  if (!(shade >= 0 && shade <= 1)) throw bad(`shade "${shade}"`, "0..1");
  if (!(exposure > 0.5 && exposure <= 1.5)) throw bad(`exposure "${exposure}"`, "0.5 < e <= 1.5");
  if (!["on", "off", "auto"].includes(highlights)) throw bad(`highlights "${highlights}"`, "on|off|auto");
  if (!["opaque", "transparent", "render-only"].includes(mode)) throw bad(`mode "${mode}"`, "opaque|transparent|render-only");
  if (!SHADOW_PRESETS[shadowName]) throw new Error(`${cat}: unknown shadow "${shadowName}" (long|short)`);
  const transparent = mode === "transparent", renderOnly = mode === "render-only";
  if (transparent && bg !== "FFFFFF") throw new Error(`${cat}: ${mode} is white-bg only (got bg ${bg})`);
  if (!/^[0-9A-F]{6}$/.test(bg)) throw bad(`bg "${bg}"`, "6 hex digits");
  // suf names the shadow render and everything derived from it: preset then pose, defaults unsuffixed.
  const suf = (shadowName === "long" ? "" : `_${shadowName}`) + (subjectPose === "upright" ? "" : `_${subjectPose}`);
  return { mode, strength, bg, shadowName, subjectPose, shadowParams: { ...SHADOW_PRESETS[shadowName], subjectPose },
           transparent, renderOnly, highlights, exposure, shade, noRelight: !relight, suf };
}

const only = arg("--skus", null), group = arg("--group", null);
let files = await collectInputs(SRC);
if (group) files = files.filter((f) => dirname(f).split("/")[0] === group);
if (only) { const set = new Set(only.split(",")); files = files.filter((f) => set.has(basename(f, extname(f)))); }
const settings = new Map();
try { for (const c of new Set(files.map((f) => dirname(f)))) settings.set(c, await resolveSettings(c)); }
catch (e) { console.error("config error: " + e.message); process.exit(1); }

await mkdir(WORK, { recursive: true });
await mkdir(FINALS, { recursive: true });
if (DEBUG) {
  initDebug({ path: join("outputs/debug", `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`) });
  logEvent({ event: "run", cli: CLI, settings: Object.fromEntries(settings), noCache: NO_CACHE, skus: files.length });
}
const overrides = Object.entries(CLI).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(" ");
console.log(`Pipeline: ${files.length} SKUs · settings=per-group${overrides ? ` · CLI:[${overrides}]` : ""}${NO_PLATE ? " · no-plate(referenceBox=originalImage)" : ""}${HD ? "" : " · no-HD"}${NO_CACHE ? " · cache=off" : ""}${DEBUG ? " · debug=on" : ""}\n`);

// ---------------------------------------------------------------------------------------------
// Stages. Each external stage is a cached file: present → read, else produce + write (+ debug image).
async function stage(sku, dir, name, path, produce, debugName) {
  const hit = !NO_CACHE && await exists(path);
  const bytes = hit ? await readFile(path) : Buffer.from(await produce());
  if (!hit) await writeFile(path, bytes);
  logEvent({ event: "stage", sku, stage: name, cache: hit ? "hit" : "miss", path });
  await dbgImg(dir, sku, debugName, bytes);
  return bytes;
}
async function dbgImg(dir, sku, name, bytes) {
  if (!DEBUG || !bytes) return;
  const path = join(dir, "debug", name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(bytes));
  logEvent({ event: "artifact", sku, name, path, bytes: bytes.length });
}
async function photoroomShadow(sku, plate, st, bg) {
  const out = await generateShadow({ apiKey: prKey, sku, image: plate, filename: `${sku}.jpg`, background: bg, outputSize: "4000x4000", padding: PADDING, format: "jpeg", shadow: st.shadowParams, referenceBox: REFBOX });
  await sleep(PHOTOROOM_PAUSE_MS); return out;
}
async function photoroomMatte(sku, plate) {
  const out = await cutout({ apiKey: prKey, sku, image: plate, filename: `${sku}.png`, outputSize: "4000x4000", padding: PADDING, hd: HD, referenceBox: REFBOX });
  await sleep(PHOTOROOM_PAUSE_MS); return out;
}
const geminiRelight = (sku, shadowBytes, prompt) =>
  generateShadowGemini({ apiKey: gemKey, sku, image: Buffer.from(shadowBytes), instruction: prompt, temperature: 0 });

function logComposite(sku, st, up, mean) {
  logEvent({ event: "composite", sku, mode: st.mode, bg: st.bg, strength: st.strength, exposure: st.exposure, shade: st.shade, highlights: st.highlights, highlightScale: Math.round(up * 100) / 100, relightMean: Math.round(mean * 10) / 10 });
}

// Render-only (very clear glass): the final IS Photoroom's render. With relight on, the matte is an
// alpha mask only, confining the lightmap to the product; colour never comes from matte or Gemini.
async function renderOnlyFinal(sku, dir, st, plate, shadowBytes, shadowBg) {
  if (st.noRelight) return shadowBytes;
  const matteBytes = await stage(sku, dir, "matte", join(dir, `matte${PLATE_SUF}${HD_SUF}.png`), () => photoroomMatte(sku, plate), "03_matte_output.png");
  const alpha = await rawAlpha(matteBytes);
  const rp = join(dir, `relit${st.suf}${PLATE_SUF}${shadowBg !== "FFFFFF" ? `_${shadowBg}` : ""}.jpg`);
  const relit = await stage(sku, dir, "relit", rp, async () => { await dbgImg(dir, sku, "04_relight_input.jpg", shadowBytes); return geminiRelight(sku, shadowBytes, RELIGHT_VARIANTS.glass); }, "05_relight_output.jpg");
  const lm = await lightmapFrom(relit), base = await rawRGB(shadowBytes);
  const mean = alphaWeightedMean(lm, alpha);
  const up = st.highlights === "off" ? 0 : st.highlights === "auto" ? headroomScale(base, alpha) : 1;
  const out = Buffer.alloc(W * W * 3);
  for (let p = 0, i = 0; p < lm.length; p++, i += 3) {
    const a = alpha[p] / 255;
    const f = 1 + (relightFactor((lm[p] - mean) / 128, up, st) - 1) * a;     // relight fades out with coverage
    for (let c = 0; c < 3; c++) { const v = base[i + c] * f; out[i + c] = clamp(v * (1 - a) + shoulder(v) * a); }
  }
  logComposite(sku, st, up, mean);
  return toJpeg(out);
}

// Opaque and transparent: crisp matte pixels over the shadow render (docs/pipeline.md §3.5).
async function compositeFinal(sku, dir, st, plate, shadowBytes) {
  const matteBytes = await stage(sku, dir, "matte", join(dir, `matte${PLATE_SUF}${HD_SUF}.png`), () => photoroomMatte(sku, plate), "03_matte_output.png");
  const alpha = await rawAlpha(matteBytes);
  const lm = new Float32Array(W * W);
  if (!st.noRelight) {
    const relit = await stage(sku, dir, "relit", join(dir, `relit${st.suf}${PLATE_SUF}.jpg`), async () => { await dbgImg(dir, sku, "04_relight_input.jpg", shadowBytes); return geminiRelight(sku, shadowBytes, RELIGHT_VARIANTS.standard); }, "05_relight_output.jpg");
    lm.set(await lightmapFrom(relit));
  }
  const subj = await rawRGB(matteBytes), base = await rawRGB(shadowBytes);
  const bgR = parseInt(st.bg.slice(0, 2), 16), bgG = parseInt(st.bg.slice(2, 4), 16), bgB = parseInt(st.bg.slice(4, 6), 16);
  const mean = alphaWeightedMean(lm, alpha);
  const up = st.highlights === "off" ? 0 : st.highlights === "auto" ? headroomScale(subj, alpha) : 1;
  const out = Buffer.alloc(W * W * 3);
  for (let p = 0, i = 0; p < lm.length; p++, i += 3) {
    const a = alpha[p] / 255;
    const fe = relightFactor((lm[p] - mean) / 128, up, st) * st.exposure;   // exposure: product only
    if (st.transparent) {
      // trust the crisp matte only where near-opaque; elsewhere Photoroom's render handles the glass
      const k = smoothstep(0.85, 1.0, a);
      for (let c = 0; c < 3; c++) out[i + c] = clamp(shoulder(subj[i + c] * fe) * k + base[i + c] * (1 - k));
      continue;
    }
    // cast-shadow darkening of the chosen bg, with the product region masked out (no edge halo)
    const sf = (a * 255 + (1 - a) * gray(base[i], base[i + 1], base[i + 2])) / 255;
    out[i] = clamp(shoulder(subj[i] * fe) * a + bgR * sf * (1 - a));
    out[i + 1] = clamp(shoulder(subj[i + 1] * fe) * a + bgG * sf * (1 - a));
    out[i + 2] = clamp(shoulder(subj[i + 2] * fe) * a + bgB * sf * (1 - a));
  }
  logComposite(sku, st, up, mean);
  return toJpeg(out);
}

// ---------------------------------------------------------------------------------------------
// Main loop
const ok = [], failed = [];
for (let i = 0; i < files.length; i++) {
  const sku = basename(files[i], extname(files[i])), cat = dirname(files[i]), st = settings.get(cat);
  const finalsDir = cat === "." ? FINALS : join(FINALS, cat);
  const deliverable = join(finalsDir, `${sku}.jpg`);
  const dir = join(WORK, sku);
  await mkdir(finalsDir, { recursive: true }); await mkdir(dir, { recursive: true });
  // Final cache key: every composite-time parameter, defaults omitted (docs/configuration.md).
  const key = [st.suf, st.transparent ? "_t" : st.renderOnly ? "_r" : "", PLATE_SUF, HD_SUF,
    st.highlights === "off" ? "_s" : st.highlights === "auto" ? "_ha" : "",
    st.exposure === 1 ? "" : `_e${Math.round(st.exposure * 100)}`,
    st.strength === 0.25 ? "" : `_st${Math.round(st.strength * 100)}`,
    st.shade === 1 ? "" : `_sh${Math.round(st.shade * 100)}`].join("");
  const finalPath = join(dir, `final${key}_${st.bg}.jpg`);
  process.stdout.write(`[${i + 1}/${files.length}] ${cat === "." ? "" : cat + "/"}${sku} [${st.mode} s=${st.strength}${st.subjectPose === "upright" ? "" : " " + st.subjectPose}] ... `);
  if (!NO_CACHE && await exists(finalPath)) { await copyFile(finalPath, deliverable); console.log("skip"); ok.push({ sku, cat, path: deliverable }); continue; }
  try {
    // 1. plate: detected and centred (opaque); contain-fit (glass modes); raw source (--no-plate)
    const source = join(SRC, files[i]);
    const plate = NO_PLATE ? await readFile(source)
      : (st.transparent || st.renderOnly) ? await squarePlate(source, W, "FFFFFF")
      : await composeBackground((await makePlate({ source })).plate, "FFFFFF");
    await dbgImg(dir, sku, "00_input_source.jpg", await readFile(source));
    await dbgImg(dir, sku, "01_plate_input.png", plate);
    // 2. shadow render: on white, except render-only renders straight onto the target bg
    const shadowBg = st.renderOnly ? st.bg : "FFFFFF";
    const sp = join(dir, `shadow${st.suf}${PLATE_SUF}${st.renderOnly && shadowBg !== "FFFFFF" ? `_${shadowBg}` : ""}.jpg`);
    const shadowBytes = await stage(sku, dir, "shadow", sp, () => photoroomShadow(sku, plate, st, shadowBg), "02_shadow_output.jpg");
    // 3–5. matte, lighting map, composite
    const finalBytes = st.renderOnly ? await renderOnlyFinal(sku, dir, st, plate, shadowBytes, shadowBg)
                                     : await compositeFinal(sku, dir, st, plate, shadowBytes);
    await writeFile(finalPath, finalBytes);
    await copyFile(finalPath, deliverable);
    await dbgImg(dir, sku, "99_final_output.jpg", finalBytes);
    logEvent({ event: "final", sku, mode: st.mode, path: finalPath, bytes: finalBytes.length });
    console.log("ok"); ok.push({ sku, cat, path: deliverable });
  } catch (e) {
    logEvent({ event: "error", sku, error: e.message });
    console.log("FAIL: " + e.message); failed.push(sku);
    if (String(e.message).includes("429")) { console.error("Rate-limited — stopping; re-run to resume."); break; }
  }
}

// Contact sheet per output group (review aid): 300 px cells, 6 columns, SKU label.
async function contactSheet(items, path) {
  const C = 300, L = 22, COLS = 6, cells = [];
  for (const { sku, path: p } of items) {
    if (!(await exists(p))) continue;
    const img = await sharp(p).resize(C, C, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).toBuffer();
    const lbl = Buffer.from(`<svg width="${C}" height="${L}"><rect width="100%" height="100%" fill="black"/><text x="6" y="16" font-family="monospace" font-size="12" fill="white">${sku}</text></svg>`);
    cells.push(await sharp({ create: { width: C, height: C + L, channels: 3, background: "#000" } }).composite([{ input: img, top: L, left: 0 }, { input: lbl, top: 0, left: 0 }]).png().toBuffer());
  }
  if (!cells.length) return;
  await sharp({ create: { width: C * COLS, height: (C + L) * Math.ceil(cells.length / COLS), channels: 3, background: "#222" } })
    .composite(cells.map((c, i) => ({ input: c, left: (i % COLS) * C, top: Math.floor(i / COLS) * (C + L) }))).jpeg({ quality: 88 }).toFile(path);
  console.log(`contact sheet → ${path}`);
}
const byCat = new Map();
for (const o of ok) { if (!byCat.has(o.cat)) byCat.set(o.cat, []); byCat.get(o.cat).push(o); }
for (const [cat, items] of byCat) await contactSheet(items, cat === "." ? SHEET : SHEET.replace(/\.jpg$/i, `_${cat.split("/")[0]}.jpg`));
console.log(`\nDone. ${ok.length} ok, ${failed.length} failed${failed.length ? ": " + failed.join(", ") : ""}`);
console.log(`Finals: ${FINALS}/`);
