// Fetch IKEA main studio shots (product on clean white) into inputs/group_<name>/ with a manifest.
//
//   node scripts/fetch_ikea.mjs search "glass vase" [--size 12]        # list candidates (no download)
//   node scripts/fetch_ikea.mjs fetch selection.json [--dry]           # download + manifest per group
//
// selection.json: { "<group>": { "note": "...", "items": [ { "image": "<mainImageUrl>", "name", "type",
//                   "product", "why": "<difficulty reason>" }, ... ] }, ... }
//
// Images come from the public product CDN at ?imwidth=4000 (most assets top out at 2000²). Only
// `_pe` (studio) images are accepted — `_ph` are lifestyle shots. Each download is checked: JPEG,
// ≥1000 px, and all four corners + mid-edges within 3 levels of white; failures are reported and
// NOT written to the manifest. SKU = the pe-number in the image filename (matches group_all naming).
// Polite: sequential, 400 ms between requests. Existing files are kept (re-run = resume).

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const UA = "Mozilla/5.0 (compatible; mpp-pipeline fetch; personal research)";
const SEARCH = "https://sik.search.blue.cdtapps.com/us/en/search-result-page";
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => stat(p).then(() => true, () => false);
const skuOf = (url) => { const m = /_pe(\d+)_/i.exec(url); if (!m) throw new Error(`no pe-number in ${url}`); return `PE${m[1]}`; };

async function search(q, size = 12) {
  const res = await fetch(`${SEARCH}?q=${encodeURIComponent(q)}&size=${size}&types=PRODUCT`, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const d = await res.json();
  const items = d?.searchResultPage?.products?.main?.items ?? [];
  return items.map((it) => it.product).filter((p) => p?.mainImageUrl && /_pe\d+_/i.test(p.mainImageUrl))
    .map((p) => ({ sku: skuOf(p.mainImageUrl), name: p.name, type: p.typeName, product: p.pipUrl, image: p.mainImageUrl, alt: p.mainImageAlt ?? "" }));
}

// white-background check on the downloaded bytes
async function check(buf, minEdge = 252) {
  const img = sharp(buf);
  const m = await img.metadata();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  const px = (x, y) => { const i = (y * W + x) * C; return Math.min(data[i], data[i + 1], data[i + 2]); };
  const probes = [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3], [W >> 1, 2], [W >> 1, H - 3], [2, H >> 1], [W - 3, H >> 1]];
  const minProbe = Math.min(...probes.map(([x, y]) => px(x, y)));
  const problems = [];
  if (m.format !== "jpeg") problems.push(`format ${m.format}`);
  if (Math.min(W, H) < 1000) problems.push(`small ${W}x${H}`);
  if (minProbe < minEdge) problems.push(`edge not white (min ${minProbe} < ${minEdge})`);
  return { width: W, height: H, minProbe, problems };
}

async function fetchGroup(group, spec, dry) {
  const dir = join("inputs", `group_${group}`);
  await mkdir(dir, { recursive: true });
  const kept = [], rejected = [];
  for (const it of spec.items) {
    const sku = skuOf(it.image);
    const url = it.image.includes("?") ? it.image : `${it.image}?imwidth=4000`;
    const out = join(dir, `${sku}.jpg`);
    let buf;
    if (await exists(out)) buf = await readFile(out);
    else if (dry) { console.log(`  [dry] ${group}/${sku} ${it.name}`); kept.push({ sku, ...it, image: url }); continue; }
    else {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (!res.ok) { rejected.push({ sku, name: it.name, why: `HTTP ${res.status}` }); console.log(`  FAIL ${group}/${sku} ${it.name}: HTTP ${res.status}`); await sleep(400); continue; }
      buf = Buffer.from(await res.arrayBuffer());
      await sleep(400);
    }
    // spec.minEdge relaxes the white-edge check for a group that deliberately collects off-white
    // studio shots (newer IKEA renders carry a faint floor gradient, edges ~240-244).
    const c = await check(buf, spec.minEdge ?? 252);
    if (c.problems.length) { rejected.push({ sku, name: it.name, why: c.problems.join("; ") }); console.log(`  REJECT ${group}/${sku} ${it.name}: ${c.problems.join("; ")}`); continue; }
    if (!(await exists(out))) await writeFile(out, buf);
    kept.push({ sku, name: it.name, type: it.type, product: it.product, image: url, size: `${c.width}x${c.height}`, why: it.why ?? "" });
    console.log(`  ok   ${group}/${sku} ${it.name} (${it.type}) ${c.width}x${c.height}`);
  }
  if (!dry) {
    const manifest = {
      source: `IKEA product images fetched from ikea.com via the public search API (main studio shot, ?imwidth=4000; most assets top out at 2000x2000)`,
      fetched: new Date().toISOString().slice(0, 10),
      group, note: spec.note ?? "", difficulty: spec.difficulty ?? "", items: kept, rejected,
    };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    if (spec.group_json && !(await exists(join(dir, "group.json")))) await writeFile(join(dir, "group.json"), JSON.stringify(spec.group_json, null, 2) + "\n");
  }
  return { kept: kept.length, rejected: rejected.length };
}

const cmd = process.argv[2];
if (cmd === "search") {
  const rows = await search(process.argv[3], parseInt(arg("--size", "12")));
  for (const r of rows) console.log(`${r.sku.padEnd(10)} ${String(r.name).padEnd(18)} ${String(r.type).padEnd(28)} ${r.alt.slice(0, 70)}\n           ${r.image}`);
} else if (cmd === "fetch") {
  const sel = JSON.parse(await readFile(process.argv[3], "utf8"));
  const dry = process.argv.includes("--dry");
  const totals = {};
  for (const [group, spec] of Object.entries(sel)) { console.log(`== group_${group}: ${spec.items.length} picks`); totals[group] = await fetchGroup(group, spec, dry); }
  console.log("\nsummary:", totals);
} else {
  console.error("usage: fetch_ikea.mjs search <query> | fetch <selection.json> [--dry]"); process.exit(1);
}
