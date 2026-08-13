// MPP uplift pipeline — one SKU at a time.
//
//   node --env-file=.env scripts/run_pipeline.mjs [--skus a,b] [--bg FFFFFF] [--strength 0.25]
//
// Per SKU:  plate (place on canvas) → Photoroom cutout (matte) → Photoroom shadow (base)
//           → Gemini relight (lighting map) → composite → outputs/finals/<sku>.jpg
//
// The cast shadow comes straight from Photoroom's shadow output (relit in place, gated by
// the matte) — nothing re-registers or crops it. Resumable (skips finished SKUs) and
// Photoroom rate-limit aware (stops the stage on 429; re-run to resume).

import { mkdir, readdir, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import sharp from "sharp";
import { makePlate, composeBackground, squarePlate } from "../src/plate.mjs";
import { cutout } from "../src/cutout.mjs";
import { generateShadow } from "../src/photoroom.mjs";
import { generateShadowGemini, RELIGHT_VARIANTS } from "../src/gemini.mjs";
import { initDebug, debugEnabled, logEvent } from "../src/debuglog.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BG = arg("--bg", "FFFFFF");
const STRENGTH = parseFloat(arg("--strength", "0.25"));
// Skip the Gemini relight stage entirely: no API call, product kept flat (relight factor = 1).
// Compositing + Photoroom cast shadow still run. GEMINI_KEY is not required in this mode.
const NO_RELIGHT = process.argv.includes("--no-relight");
// Force the Gemini relight ON even for a mode/group whose config defaults it off (e.g. render-only
// glass, which ships relight:false). Mutually exclusive with --no-relight (that wins).
const RELIGHT = process.argv.includes("--relight");
// Ignore all cached intermediates/finals: regenerate shadow, matte, relit, and final from scratch
// every run (re-fetches Photoroom + Gemini). Stages are still WRITTEN to outputs/work/ so a normal
// (cached) run afterwards can resume. Use when caches are stale or you want a guaranteed-fresh run.
const NO_CACHE = process.argv.includes("--no-cache");
// Debug: log every API request/response as JSONL (outputs/debug/run-<ts>.jsonl) AND save the
// input+output IMAGE of every stage under outputs/work/<sku>/debug/. Enabled by --debug.
const DEBUG = process.argv.includes("--debug");
// TRANSPARENT products (clear glass, etc). The default composite `subj*a + bg*(1-a)` assumes
// opaque product pixels; for clear glass the alpha is PARTIAL across the whole body and Photoroom's
// color-decontamination there is dark, so `subj*a` paints hard dark rims — the "fried" look.
// In this mode the product color comes from the crisp matte only where near-opaque (alpha≈1) and
// from Photoroom's shadow RENDER elsewhere: out = subj*k + base*(1-k), k = smoothstep(0.85,1,alpha).
// The render is on white, so this mode is WHITE-BG ONLY (the render bg cannot be recolored).
const TRANSPARENT = process.argv.includes("--transparent");
// RENDER-ONLY (very-transparent glass). Even --transparent trusts the crisp matte where
// alpha >= 0.85 (k = smoothstep(0.85,1)), and on glass the rims/lids/clips are near-opaque —
// so removeBackground's edge decontamination there still paints a fried rim. This mode drops
// the matte term ENTIRELY: the final IS Photoroom's shadow render (product-on-white + cast
// shadow), which handles transparency correctly and has no decontam rims. No matte, no relight.
// WHITE-BG ONLY (the render bg cannot be recolored). Cached as final*_r_*.
const RENDER_ONLY = process.argv.includes("--render-only");
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
// Shadow presets. `long` = directional cast (dramatic, but diverges per-leg on legged furniture).
// `short` = soft grounding shadow (consistent). Cached separately (shadow_<preset>.jpg etc.).
const SHADOW_PRESETS = {
  long:  { mode: "ai.auto-with-overrides", softness: 0.6,  intensity: 0.55, spread: "long",  direction: "behindRight", subjectPose: "upright" },
  short: { mode: "ai.auto-with-overrides", softness: 0.75, intensity: 0.5,  spread: "short",                           subjectPose: "upright" },
};
// Settings resolve per SKU as: explicit CLI flag > inputs/<group>/group.json > built-in default.
// CLI holds only the flags actually passed (undefined = "not passed" → fall through to group.json).
const CLI = {
  bg:       process.argv.includes("--bg") ? BG.toUpperCase() : undefined,
  strength: process.argv.includes("--strength") ? STRENGTH : undefined,
  shadow:   process.argv.includes("--shadow") ? arg("--shadow", null) : undefined,
  relight:  NO_RELIGHT ? false : (RELIGHT ? true : undefined),
  mode:     arg("--mode", null) || (RENDER_ONLY ? "render-only" : TRANSPARENT ? "transparent" : undefined),
};
const SRC = "inputs";
const WORK = "outputs/work";                                  // per-SKU intermediates (cached)
const FINALS = arg("--out", "outputs/finals");                // flat folder of final images
const SHEET = arg("--sheet", "outputs/contact_sheet.jpg");    // contact sheet path
const W = 4000;
const prKey = process.env.PHOTOROOM_KEY, gemKey = process.env.GEMINI_KEY;
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
// tight bounding box of a 1-channel alpha buffer (pixels above thr)
function alphaBbox(a, W, H, thr = 128) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (a[y * W + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error("empty alpha (no subject)");
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => stat(p).then(() => true, () => false);

if (!prKey || (!gemKey && !NO_RELIGHT)) { console.error("Set PHOTOROOM_KEY and GEMINI_KEY (in .env)."); process.exit(1); }

// Collect inputs recursively so category subfolders (inputs/group_glass/…) are preserved as
// the relative path; a flat inputs/ still works (category = "."). Finals mirror this structure.
async function collectInputs(root, base = "") {
  const out = [];
  for (const e of (await readdir(join(root, base), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? join(base, e.name) : e.name;
    if (e.isDirectory()) out.push(...await collectInputs(root, rel));
    else if (/\.(jpe?g|png|webp)$/i.test(e.name)) out.push(rel);
  }
  return out;
}
const only = arg("--skus", null);
const group = arg("--group", null);   // limit to one category subfolder (e.g. group_glass)
let files = await collectInputs(SRC);
if (group) files = files.filter((f) => dirname(f).split("/")[0] === group);
if (only) { const set = new Set(only.split(",")); files = files.filter((f) => set.has(basename(f, extname(f)))); }

// Per-group config: inputs/<group>/group.json may set { mode, strength, shadow, bg, relight }.
// group.json is not an image, so collectInputs ignores it. Cached per top-level group folder.
const groupCfgCache = new Map();
async function groupConfig(cat) {
  if (cat === ".") return {};
  const top = cat.split("/")[0];
  if (groupCfgCache.has(top)) return groupCfgCache.get(top);
  let cfg = {};
  try { cfg = JSON.parse(await readFile(join(SRC, top, "group.json"), "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw new Error(`bad ${top}/group.json: ${e.message}`); }
  groupCfgCache.set(top, cfg);
  return cfg;
}
// Resolve effective settings for a category: CLI flag > group.json > default. Validated here.
async function resolveSettings(cat) {
  const gc = await groupConfig(cat);
  const mode = CLI.mode ?? gc.mode ?? "opaque";
  const strength = CLI.strength ?? gc.strength ?? 0.25;
  const bg = String(CLI.bg ?? gc.bg ?? "FFFFFF").toUpperCase();
  const shadowName = CLI.shadow ?? gc.shadow ?? "long";
  const relightPref = CLI.relight ?? gc.relight ?? true;
  const transparent = mode === "transparent", renderOnly = mode === "render-only";
  if (!["opaque", "transparent", "render-only"].includes(mode)) throw new Error(`${cat}: bad mode "${mode}" (opaque|transparent|render-only)`);
  const shadowParams = SHADOW_PRESETS[shadowName];
  if (!shadowParams) throw new Error(`${cat}: unknown shadow "${shadowName}" (long|short)`);
  // transparent blends against Photoroom's white render, so it stays white-only. render-only's final
  // IS the render, and Photoroom can render the shadow directly on any bg, so it supports non-white.
  if (transparent && bg !== "FFFFFF") throw new Error(`${cat}: ${mode} is white-bg only (got bg ${bg})`);
  if (!/^[0-9A-F]{6}$/.test(bg)) throw new Error(`${cat}: bad bg "${bg}" (6 hex digits)`);
  return { mode, strength, bg, shadowName, shadowParams, transparent, renderOnly,
           noRelight: !relightPref, suf: shadowName === "long" ? "" : `_${shadowName}` };
}
// Pre-resolve + validate every group's settings once, so config errors fail fast before any work.
const settings = new Map();
try { for (const c of [...new Set(files.map((f) => dirname(f)))]) settings.set(c, await resolveSettings(c)); }
catch (e) { console.error("config error: " + e.message); process.exit(1); }

await mkdir(WORK, { recursive: true });
await mkdir(FINALS, { recursive: true });
if (DEBUG) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  initDebug({ path: join("outputs/debug", `run-${ts}.jsonl`) });
  logEvent({ event: "run", cli: CLI, settings: Object.fromEntries(settings), noCache: NO_CACHE, skus: files.length });
}
// Save a stage's input/output image under outputs/work/<sku>/debug/ (only when --debug).
// `nn_name` orders the files by stage; ext is inferred from the caller. Also logs the path.
async function dbgImg(dir, sku, name, bytes) {
  if (!DEBUG || !bytes) return;
  const ddir = join(dir, "debug"); await mkdir(ddir, { recursive: true });
  const path = join(ddir, name);
  await writeFile(path, Buffer.from(bytes));
  logEvent({ event: "artifact", sku, name, path, bytes: bytes.length });
}
const ov = Object.entries(CLI).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(" ");
console.log(`Pipeline: ${files.length} SKUs · settings=per-group${ov ? ` · CLI:[${ov}]` : ""}${NO_CACHE ? " · cache=off" : ""}${DEBUG ? " · debug=on" : ""}\n`);

const ok = [], failed = [];
for (let i = 0; i < files.length; i++) {
  const sku = basename(files[i], extname(files[i]));
  const cat = dirname(files[i]);                          // category subpath ("." if flat)
  const finalsDir = cat === "." ? FINALS : join(FINALS, cat); await mkdir(finalsDir, { recursive: true });
  const deliverable = join(finalsDir, `${sku}.jpg`);      // final lands in the mirrored category folder
  const dir = join(WORK, sku); await mkdir(dir, { recursive: true });
  const st = settings.get(cat);                              // resolved per-group settings
  const modeSuf = st.transparent ? "_t" : st.renderOnly ? "_r" : "";
  const finalPath = join(dir, `final${st.suf}${modeSuf}_${st.bg}.jpg`);   // cache per shadow-preset + bg (+ composite mode)
  process.stdout.write(`[${i + 1}/${files.length}] ${cat === "." ? "" : cat + "/"}${sku} [${st.mode} s=${st.strength}] ... `);
  if (!NO_CACHE && await exists(finalPath)) { await copyFile(finalPath, deliverable); console.log("skip"); ok.push({ sku, cat, path: deliverable }); continue; }
  try {
    // 1. plate — place the subject on a 4000² white canvas (brief-spec framing).
    //    Glass (transparent/render-only): use squarePlate — makePlate's luminance bbox crops off
    //    bright glass edges/clips. Opaque: makePlate detects & centers the subject as usual.
    let plateWhite;
    if (st.transparent || st.renderOnly) {
      plateWhite = await squarePlate(join(SRC, files[i]), W, "FFFFFF");
    } else {
      const { plate } = await makePlate({ source: join(SRC, files[i]) });
      plateWhite = await composeBackground(plate, "FFFFFF");
    }
    await dbgImg(dir, sku, "00_input_source.jpg", await readFile(join(SRC, files[i])));
    await dbgImg(dir, sku, "01_plate_input.png", plateWhite);   // exact bytes sent to both Photoroom calls

    // 2. Photoroom shadow base — outputSize 4000², padding 0.10. Photoroom pads around the
    //    PRODUCT (400 px margin) and lets the cast shadow fall into the margin, so the product
    //    framing matches the matte exactly (verified: same product bbox within ~6 px) while the
    //    shadow still has room. Cached.
    // Opaque/transparent need the shadow base on WHITE (the composite derives the shadow factor from
    // it / blends against it). Render-only's render IS the final, so render it directly on the target
    // bg; cache that variant under a bg-specific name so a later white run doesn't reuse the grey base.
    const shadowBg = st.renderOnly ? st.bg : "FFFFFF";
    const sp = join(dir, `shadow${st.suf}${st.renderOnly && shadowBg !== "FFFFFF" ? `_${shadowBg}` : ""}.jpg`);
    let shadowBytes;
    const shadowCached = !NO_CACHE && await exists(sp);
    if (shadowCached) shadowBytes = await readFile(sp);
    else { shadowBytes = await generateShadow({ apiKey: prKey, sku, image: plateWhite, filename: `${sku}.jpg`, background: shadowBg, outputSize: "4000x4000", padding: 0.10, format: "jpeg", shadow: st.shadowParams }); await writeFile(sp, Buffer.from(shadowBytes)); await sleep(1100); }
    logEvent({ event: "stage", sku, stage: "shadow", cache: shadowCached ? "hit" : "miss", path: sp });
    await dbgImg(dir, sku, "02_shadow_output.jpg", shadowBytes);

    // RENDER-ONLY (glass): the final IS the Photoroom render — no matte COLOR term (the matte's dark
    // decontamination fries glass rims), so the product pixels stay the render's. When relight is on
    // we still add gentle depth: the matte alpha is used ONLY as a MASK to confine the Gemini
    // lightmap to the product, leaving the flat bg untouched. Color never comes from matte or Gemini.
    if (st.renderOnly) {
      let outBytes = shadowBytes;                             // default: render AS-IS, no resample/re-encode
      if (!st.noRelight) {
        // matte — alpha MASK only (never color). Same padding:0.10 frame as the render.
        const ocp = join(dir, "matte.png");
        let matteBytes;
        const matteCached = !NO_CACHE && await exists(ocp);
        if (matteCached) matteBytes = await readFile(ocp);
        else { matteBytes = await cutout({ apiKey: prKey, sku, image: plateWhite, filename: `${sku}.png`, outputSize: "4000x4000", padding: 0.10 }); await writeFile(ocp, Buffer.from(matteBytes)); await sleep(1100); }
        logEvent({ event: "stage", sku, stage: "matte", cache: matteCached ? "hit" : "miss", path: ocp });
        await dbgImg(dir, sku, "03_matte_output.png", matteBytes);
        const sAlpha = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();
        // Gemini GLASS relight → low-passed lighting gradient (never pixels; see invariant 3). Glass
        // uses the `glass` prompt (sculpt rim/edge speculars, leave the see-through body true).
        const rp = join(dir, `relit${st.suf}${shadowBg !== "FFFFFF" ? `_${shadowBg}` : ""}.jpg`);
        let relit;
        const relitCached = !NO_CACHE && await exists(rp);
        if (relitCached) relit = await readFile(rp);
        else { await dbgImg(dir, sku, "04_relight_input.jpg", shadowBytes); relit = await generateShadowGemini({ apiKey: gemKey, sku, image: Buffer.from(shadowBytes), instruction: RELIGHT_VARIANTS.glass, temperature: 0 }); await writeFile(rp, Buffer.from(relit)); }
        logEvent({ event: "stage", sku, stage: "relit", cache: relitCached ? "hit" : "miss", path: rp });
        await dbgImg(dir, sku, "05_relight_output.jpg", relit);
        // Absolute-luminance lightmap: lm = luma(blur(relit)), applied as a gentle relative gradient
        // (mean-normalized below). The delta variant (relit − base) was tried and fried at strength.
        const g = await sharp(relit).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
        const lm = new Float32Array(W * W);
        for (let p = 0, k = 0; p < lm.length; p++, k += 3) lm[p] = gray(g[k], g[k + 1], g[k + 2]);
        const base = await sharp(Buffer.from(shadowBytes)).resize(W, W).removeAlpha().raw().toBuffer();
        let gs = 0, aw = 0; for (let p = 0; p < lm.length; p++) { const a = sAlpha[p] / 255; gs += lm[p] * a; aw += a; }
        const mean = aw > 0 ? gs / aw : 128;
        const out = Buffer.alloc(W * W * 3);
        for (let p = 0, i2 = 0; p < lm.length; p++, i2 += 3) {
          const a = sAlpha[p] / 255;                          // relight scaled by coverage → flat bg untouched
          const f = 1 + ((lm[p] - mean) / 128) * st.strength * a;
          out[i2] = clamp(base[i2] * f); out[i2 + 1] = clamp(base[i2 + 1] * f); out[i2 + 2] = clamp(base[i2 + 2] * f);
        }
        outBytes = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
        logEvent({ event: "composite", sku, mode: st.mode, bg: st.bg, strength: st.strength, relightMean: Math.round(mean * 10) / 10 });
      }
      await writeFile(finalPath, Buffer.from(outBytes));
      await copyFile(finalPath, deliverable);
      await dbgImg(dir, sku, "99_final_output.jpg", outBytes);
      logEvent({ event: "final", sku, mode: st.mode, path: finalPath, bytes: outBytes.length });
      console.log("ok"); ok.push({ sku, cat, path: deliverable }); continue;
    }

    // 3. Matte — removeBackground(plateWhite, 4000², padding 0.10): crisp original pixels + alpha
    //    at the SAME product framing as the shadow base (both pad around the product). Cached.
    const ocp = join(dir, "matte.png");
    let matteBytes;
    const matteCached = !NO_CACHE && await exists(ocp);
    if (matteCached) matteBytes = await readFile(ocp);
    else { matteBytes = await cutout({ apiKey: prKey, sku, image: plateWhite, filename: `${sku}.png`, outputSize: "4000x4000", padding: 0.10 }); await writeFile(ocp, Buffer.from(matteBytes)); await sleep(1100); }
    logEvent({ event: "stage", sku, stage: "matte", cache: matteCached ? "hit" : "miss", path: ocp });
    await dbgImg(dir, sku, "03_matte_output.png", matteBytes);
    const sAlpha = await sharp(matteBytes).resize(W, W).ensureAlpha().extractChannel("alpha").raw().toBuffer();

    // 4. Gemini relight of the shadow base → LIGHTING MAP only (never pixels). Cached.
    //    Generated at 2K — requesting 4K makes the model tile/hallucinate texture (verified:
    //    same prompt is clean at 2K, tiles at 4K regardless of input size; see src/gemini.mjs).
    //    Upscaled to working res, then LOW-PASSED (blur) so only the smooth lighting gradient
    //    transfers to the composite — never Gemini texture, JPEG noise, or tiling residue.
    const rp = join(dir, `relit${st.suf}.jpg`);
    const lm = new Float32Array(W * W);
    if (!st.noRelight) {
      let relit;
      const relitCached = !NO_CACHE && await exists(rp);
      if (relitCached) relit = await readFile(rp);
      else { await dbgImg(dir, sku, "04_relight_input.jpg", shadowBytes); relit = await generateShadowGemini({ apiKey: gemKey, sku, image: Buffer.from(shadowBytes), instruction: RELIGHT_VARIANTS.standard, temperature: 0 }); await writeFile(rp, Buffer.from(relit)); }
      logEvent({ event: "stage", sku, stage: "relit", cache: relitCached ? "hit" : "miss", path: rp });
      await dbgImg(dir, sku, "05_relight_output.jpg", relit);
      const g = await sharp(relit).resize(W, W, { fit: "fill" }).blur(20).removeAlpha().raw().toBuffer();
      for (let p = 0, k = 0; p < lm.length; p++, k += 3) lm[p] = gray(g[k], g[k + 1], g[k + 2]);
    }

    // 5. Composite — matte, original, and shadow all share ONE Photoroom frame, so NO alignment.
    //    Verified: matte product bbox == shadow product bbox (both fit-to-frame by Photoroom).
    //    - Subject = the MATTE itself (removeBackground returns the ORIGINAL crisp pixels + a straight
    //      anti-aliased alpha). Kept straight (NOT flattened) so the edge decontaminates onto ANY bg.
    //    - Background = `bg` darkened by the cast shadow: shadowFactor = luminance of the shadow-on-
    //      white base / 255 (1 = no shadow, <1 = shadow). The product's own darkness is masked out of
    //      that factor via the alpha, so a non-white bg gets no dark edge halo. For white bg this
    //      reduces exactly to the original shadow base.
    //    - Relight is the shadow-base lightmap (same frame), applied to the product only.
    const subj = await sharp(matteBytes).resize(W, W).removeAlpha().raw().toBuffer();   // straight RGB
    const base = await sharp(Buffer.from(shadowBytes)).resize(W, W).removeAlpha().raw().toBuffer();
    const bgR = parseInt(st.bg.slice(0, 2), 16), bgG = parseInt(st.bg.slice(2, 4), 16), bgB = parseInt(st.bg.slice(4, 6), 16);
    let gs = 0, aw = 0; for (let p = 0; p < lm.length; p++) { const a = sAlpha[p] / 255; gs += lm[p] * a; aw += a; }
    const mean = aw > 0 ? gs / aw : 128;
    const out = Buffer.alloc(W * W * 3);
    for (let p = 0, i2 = 0; p < lm.length; p++, i2 += 3) {
      const a = sAlpha[p] / 255;                            // crisp subject coverage
      const f = 1 + ((lm[p] - mean) / 128) * st.strength;   // gentle directional relight
      if (st.transparent) {
        // trust the crisp matte only where near-opaque; elsewhere take Photoroom's (correct-for-glass)
        // render, which already carries the product-on-white + cast shadow. No dark decontam rims.
        const k = smoothstep(0.85, 1.0, a);
        out[i2] = clamp(subj[i2] * f * k + base[i2] * (1 - k));
        out[i2 + 1] = clamp(subj[i2 + 1] * f * k + base[i2 + 1] * (1 - k));
        out[i2 + 2] = clamp(subj[i2 + 2] * f * k + base[i2 + 2] * (1 - k));
        continue;
      }
      // cast-shadow darkening of the chosen bg; product region (a→1) excluded so no edge halo
      const sf = (a * 255 + (1 - a) * gray(base[i2], base[i2 + 1], base[i2 + 2])) / 255;
      const br = bgR * sf, bg2 = bgG * sf, bb2 = bgB * sf;
      out[i2] = clamp(subj[i2] * f * a + br * (1 - a));
      out[i2 + 1] = clamp(subj[i2 + 1] * f * a + bg2 * (1 - a));
      out[i2 + 2] = clamp(subj[i2 + 2] * f * a + bb2 * (1 - a));
    }
    // Padding (400 px margin) already comes from Photoroom's padding:0.10 framing — write as-is.
    const finalJpeg = await sharp(out, { raw: { width: W, height: W, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    await writeFile(finalPath, finalJpeg);
    await copyFile(finalPath, deliverable);
    logEvent({ event: "composite", sku, mode: st.mode, bg: st.bg, strength: st.strength, relightMean: Math.round(mean * 10) / 10 });
    await dbgImg(dir, sku, "99_final_output.jpg", finalJpeg);
    logEvent({ event: "final", sku, mode: st.mode, path: finalPath, bytes: finalJpeg.length });
    console.log("ok"); ok.push({ sku, cat, path: deliverable });
  } catch (e) {
    logEvent({ event: "error", sku, error: e.message });
    console.log("FAIL: " + e.message); failed.push(sku);
    if (String(e.message).includes("429")) { console.error("Rate-limited — stopping; re-run to resume."); break; }
  }
}

// One contact sheet per category, mirroring the finals folders. For flat finals (cat ".")
// the sheet keeps its plain --sheet path; categorized runs append the category to the name.
const byCat = new Map();
for (const o of ok) { if (!byCat.has(o.cat)) byCat.set(o.cat, []); byCat.get(o.cat).push(o); }
for (const [cat, items] of byCat) {
  const cells = [];
  for (const { sku, path } of items) {
    if (!(await exists(path))) continue;
    const C = 300, L = 22;
    const img = await sharp(path).resize(C, C, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).toBuffer();
    const lbl = Buffer.from(`<svg width="${C}" height="${L}"><rect width="100%" height="100%" fill="black"/><text x="6" y="16" font-family="monospace" font-size="12" fill="white">${sku}</text></svg>`);
    cells.push(await sharp({ create: { width: C, height: C + L, channels: 3, background: "#000" } }).composite([{ input: img, top: L, left: 0 }, { input: lbl, top: 0, left: 0 }]).png().toBuffer());
  }
  if (!cells.length) continue;
  const sheetPath = cat === "." ? SHEET : SHEET.replace(/\.jpg$/i, `_${cat.split("/")[0]}.jpg`);
  const C = 300, L = 22, COLS = 6, ROWS = Math.ceil(cells.length / COLS);
  await sharp({ create: { width: C * COLS, height: (C + L) * ROWS, channels: 3, background: "#222" } })
    .composite(cells.map((c, i) => ({ input: c, left: (i % COLS) * C, top: Math.floor(i / COLS) * (C + L) }))).jpeg({ quality: 88 })
    .toFile(sheetPath);
  console.log(`contact sheet → ${sheetPath}`);
}
console.log(`\nDone. ${ok.length} ok, ${failed.length} failed${failed.length ? ": " + failed.join(", ") : ""}`);
console.log(`Finals: outputs/finals/  (flat, one image per SKU)`);
