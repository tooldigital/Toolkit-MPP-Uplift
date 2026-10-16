# Product categorization set — difficulty axes for the uplift pipeline

88 IKEA studio shots in 14 groups under `inputs/group_<axis>/`, one group per thing that is known or
expected to break a pipeline stage. Purpose: run each group, record which stage fails and how, and plan
per-category handling before a real catalog lands. Nothing here is a deliverable.

Fetched 2026-10-15 with `scripts/fetch_ikea.mjs` from `inputs/catalog_selection.json` (re-runnable;
existing files are kept). Every image is the product's main studio shot from the public IKEA CDN at the
max resolution it serves (2000×2000 for all of these). Each `manifest.json` records SKU, model, product
page, image URL, size and the reason the item was picked. `group_glassware` and `group_fur` ship a
`group.json` mirroring Iman's glass (render-only) and plush (strength 0.08) settings; every other group
runs on the built-in opaque defaults until a run says otherwise.

These groups do not overlap Iman's `group_chair` / `group_sofa` (large opaque upholstery, the easy case)
or the empty `group_glass` / `group_plush` folders.

## Axis → expected failure → where it lands in the pipeline

| Group | n | What's hard | Stage at risk | Existing lever | Measured 2026-10-15 (details below) |
|---|---|---|---|---|---|
| glassware | 8 | see-through body, bright rims, sets of overlapping glasses | plate (luminance bbox crops bright edges), matte (partial alpha everywhere → fried rims) | `mode: render-only` / `transparent`, `squarePlate` | **8/8 OK** (render-only). No fried rims, shadow present. Relight (glass prompt) OK on 2/2. |
| fur | 6 | fur silhouette; three items lie flat (BLÅHAJ, GOSIG GOLDEN, sheepskin) | matte (halo at fur edge), shadow (flat items get none — the otter case) | strength 0.08; `docs/plush_f7f7f7.md` band/dehalo experiments | **4/6 OK**. Edges clean on white. 2 flat items (sheepskin, rug) get a standing-panel shadow → shadow stage; needs `flatlay` pose. |
| legs | 8 | 3–4 thin legs, tripod bases, splayed metal legs | shadow (`long` preset sends one leg's shadow the wrong way — invariant 4); thin legs vs ±3 px Photoroom scatter | `--shadow short`; delete + re-run | **8/8 OK**. No wrong-way leg this run; cast behind-right on 8/8. Relight OK on 2/2 (LISABO clip 1.2% → 0.1% with `highlights auto`). |
| white | 6 | near-white product on white (UPPLAND, white mug, bath mat) | plate (threshold 245 misses it), relight (no headroom → clipping), composite (no bg contrast) | `highlights: auto/off`, `exposure` | **6/6 OK** on white. Plate threshold held on all 6. Bath mat: standard matte 97% partial alpha (ghost on grey) → fixed by HD matte (now default); its shadow is a standing card. Relight OK, UPPLAND clip 0.05%. |
| dark | 4 | black furniture, dark upholstery, black candlesticks | relight (shade half crushes recesses), matte (dark decontamination rim) | `shade` | **4/4 OK**. Shadows behind-right, framing 3149–3193 px. No crush at strength 0.25 (NORDVIKEN p01 35 → 32). VEDBO's pale wood legs clip 2.2% under relight → `highlights auto` 0.0%. |
| reflective | 7 | mirror faces, chrome, brushed/polished steel | matte (reflections read as background), relight (speculars fight the lightmap), mirror face ≈ white | none yet | **7/7 OK on white**. Both mirror faces are 91–98% partial alpha in the matte → the backdrop shows through on any non-white bg. Relight blows chrome (bowl clip 8.2%) → `highlights auto` fixes (0.1%). |
| flat | 6 | rugs shown top-down, boards, trays, bath mat | shadow (`subjectPose: upright` is wrong; nothing vertical to anchor a cast shadow) | `subjectPose: flatlay` exists in the Photoroom wrapper but is not wired to a config key | **2/6 OK** (the two angled boards). 3 top-down rugs get a standing-panel shadow (cast reaches 0.7 widths right); STOENSE standard matte 63% partial (pale cloud) → fixed by HD. `--shadow short` does not fix; `subjectPose: flatlay` does (not wired). |
| open | 7 | wire shelving, racks, carts; white wire on white | matte (many holes), shadow (falls through gaps), plate (thin white frame below threshold) | none yet | **5/7 OK**. EKRAR + RIGGA (thin white frames) get no cast shadow (3k / 56k px vs 250k+); `--shadow short` does not help. Wire bodies 36–52% partial alpha (ghost on grey). |
| plant | 6 | fine leaves, fronds, thin stems | matte precision; 2K lightmap loses stems; many small shadow casters | none yet | **6/6 OK**. Fine leaves clean with HD. Cut stems get no shadow (correct). Relight OK on 2/2. |
| textile | 5 | soft folded edges, fringe, sheer curtains | matte (fringe, semi-transparent sheer), relight on near-white folds | `highlights`, maybe `transparent` for sheers | **5/5 OK**. Fringe and sheer edges intact on white. Relight OK on 2/2. |
| tall | 4 | floor lamps: extreme aspect, tiny footprint | plate/composite (PE870292 precedent: 516 px wide subject, huge empty margins), shadow of a thin pole | none needed yet — verify | **4/4 OK**. Framing 3192–3193 px, base-only shadows. Relight blows TÅGARP's shade (clip 10.7%) → `highlights auto` fixes (0.0%). |
| small | 7 | mugs, bowls, candlesticks | shadow (ellipse base, fine), glossy speculars, white mug on white | — (expected easy; control group) | **7/7 OK**. Control group holds. Relight OK on 2/2. |
| lit | 7 | paper/fabric/frosted shades, lit LED lamps | relight contradicts the lamp's own glow; translucent shade blends into bg | none yet | **3/7 OK**. All 7 mattes fine; the 4 hanging pendants get a floor-contact shadow under a cord → no knob turns the shadow off. Relight OK on 2/2. |
| offwhite | 7 | **newer IKEA renders**: backdrop ≈ 242–247 (not 255), faint tinted wall, baked floor shadow | plate (threshold 245 sees the whole frame as subject), composite (assumes a white base), shadow (two shadows: baked + Photoroom) | none — needs bg normalisation or a plate that detects on contrast, not absolute luminance | **7/7 OK**. Plate bbox = whole frame (threshold 245 fails), but Photoroom reframes and drops the baked floor shadow: single shadow, clean white. Relight OK on 2/2. |

The last row is new information: as of 2026-10 the search results for bookcases and bedding return
this style for the newest assets (`pe1038xxx`+). The fetch script rejects them by default (edge < 252);
`minEdge: 236` in the selection admits them. Any future catalog pull should expect a mix.

## How to use it

```
npm run pipeline -- --group group_legs --no-relight      # Photoroom only: shadow + matte, cheap
npm run pipeline -- --group group_glassware              # uses its group.json (render-only)
node scripts/qc_chair_shadow_zoom.mjs --group group_legs # Iman's per-leg shadow QC
```

Suggested order: `legs`, `white`, `flat`, `open` first (they exercise the default opaque path and are the
most likely real-catalog categories), then `offwhite` (input hygiene), then `glassware`/`fur`/`reflective`
(each needs its own mode). Record per group: stage that failed, how many of n, and whether an existing
lever fixes it. That table is the categorization plan.

## Not covered (deliberately)

- Large opaque upholstery: already `group_sofa` / `group_chair`.
- Multi-item sets other than the glass set and the two candlestick pairs (sets change the framing rule).
- Lifestyle (`_ph`) shots: not on white; the pipeline's input contract excludes them.

## Measured results — 2026-10-15

All 88 SKUs went through the Photoroom-only path (`--no-relight`, 2 calls per SKU, `dark` excluded by the run
order), then 2 representative SKUs per group through the full relight. Finals: `outputs/catalog_finals/<group>/`,
per-group sheets `outputs/catalog_sheet_<group>.jpg`, relight finals `outputs/catalog_relight/`, `highlights auto`
variants `outputs/catalog_relight_ha/`, lever re-runs `outputs/catalog_levers/{short,hd}/`, flatlay renders
`outputs/experiments/catalog_flatlay/`, zoom/QC sheets `outputs/catalog_qc_*.jpg`, logs `outputs/catalog_logs/`.
Spend: 219 Photoroom calls (168 pass 1 + 9 lever re-runs + 40 HD re-renders + 2 glass mattes for relight),
26 Gemini calls. No 429 / 402.

**Caveat on the matte.** `b60026f` (HD removal becomes the default) landed on `main` at 15:59 while pass 1 was
running. legs, white, flat, open, offwhite and fur rendered with the standard matte first; they were re-rendered
with HD afterwards (shadow cached, 40 matte calls) so every number below is on the HD matte unless it says
"standard". HD is strictly better where it differs: STOENSE 63% → 1.4% partial alpha, ALSTERN 97% → 1.8%,
RÄVSTEN loses a light seam between leg and shadow; no SKU got worse.

Measured per SKU from the cached stages (no API calls): product bbox in the 4000² frame (spec 3200 px / 400 px
margin), % of product pixels with partial alpha (5–249), cast-shadow area outside the matte (render < 245 where
α < 0.05) and its centroid offset from the product in product widths, and for relight the % of product pixels at
≥ 254 before/after plus p01/p50/p90 luminance.

### Per group

| Group | n | OK | Failing stage | Symptom (measured) | Existing lever | Verdict |
|---|---|---|---|---|---|---|
| legs | 8 | 8 | — | bbox 3188–3195 px, cast behind-right 8/8, no wrong-way leg (`qc_chair_shadow_zoom` sheet `outputs/catalog_qc_legs_zoom.jpg`). Relight: SKOGSTA clip 0.00%, LISABO 1.18% (pale wood lifted). | `highlights auto` → LISABO 0.08% | production-ready |
| white | 6 | 6 | (matte, standard only) | Plate threshold 245 found every subject (all have edges < 245). ALSTERN bath mat: standard matte alpha spread 0–255 over the whole body (median ≈170; invisible on white, ghosts on grey) — HD matte 1.8% partial. Its shadow is a standing card (cast 0.74 widths right) — see flat. UPPLAND relight: clip 0.05% at `on` (shoulder holds), p01 166 → 143 on the shade side; GULLABERG 0.00%. | HD (default now); `highlights auto` trims the lift (UPPLAND p90 251 → 248) | production-ready (bath mat is a flat item, see flat) |
| flat | 6 | 2 | shadow (3), matte-standard (1) | Angled boards OK. Top-down rugs (LOHALS, TOFTBO, MARKBLÅMME) get a standing-panel cast reaching 0.68–0.71 widths to the right. STOENSE standard matte 63% partial (pale cloud through the middle) — HD 1.4%. Relight on MARKBLÅMME blows the cream squares: clip 0.76% → 13.35%. | `--shadow short`: foot shadow, still reads as a standing panel. `subjectPose: flatlay` (in `photoroom.mjs`, not wired to a config key): thin contact shadow, correct. `highlights auto`: MARKBLÅMME 1.42%. | fixable: wire `subjectPose` (small) |
| open | 7 | 5 | shadow (2) | EKRAR and RIGGA (thin white tube frames) get no cast: 3k / 56k shadow px vs 164k–1020k for the rest. Wire bodies (OMAR, RISATORP, EKRAR, RIGGA) 36–52% partial alpha — fine on white, would ghost on grey. Relight OK (OMAR clip 0.78%, RÅSKOG 0.00%). | `--shadow short`: 1k / 15k px, no help. | needs new work only for thin-white-frame shadow; 5/7 production-ready |
| offwhite | 7 | 7 | plate (masked) | `makePlate` bbox = the whole 2000² frame on all 7 (bg 244–246 < threshold 245). Photoroom then detects the product itself, pads it to 3185–3191 px and drops the baked floor shadow: single cast, white bg, no double shadow. LAIVA relight p01 7 → 6 (no crush), NATTJASMIN clip 0.00%. | none needed today; the plate stage is a no-op here and only Photoroom's padding saves it | production-ready, but the plate should detect on contrast before a real catalog mixes sources |
| glassware | 8 | 8 | — | render-only: no fried rims, bodies see-through, shadow present (set of 6 and glass block included). Framing not measurable without a matte; left/top margins 401–403 px. Relight with the glass prompt on POKAL / carafe: no visible artefact. | `mode: render-only` (group.json) | production-ready |
| fur | 6 | 4 | shadow (2) | Fur edges clean on white (sheepskin edge zoom `outputs/catalog_qc_edges_a.jpg`). ULLERSLEV sheepskin and VOLLERSLEV rug lie flat and get a standing-panel cast (0.66 / 0.75 widths right). Relight at 0.08: DJUNGELSKOG clip 0.07%, sheepskin 0.15%. | same as flat: `flatlay` pose | fixable with the flat fix |
| reflective | 7 | 7 on white | matte (2, latent), relight (1) | LINDBYN / HOVET mirror faces are 98% / 91% partial alpha — the matte treats the reflection as background; on white it passes, on any other bg the backdrop shows through the mirror. AFTONHAJ steel bowl relight: clip 0.00% → 8.23%, the chrome highlight flattens to a plateau. | `highlights auto` → 0.08%, highlight shape kept. Nothing for the mirror alpha. | production-ready on white with `highlights auto`; mirrors need new work for non-white |
| plant | 6 | 6 | — | HD matte keeps fronds and bamboo leaves (zoom `outputs/catalog_qc_edges_b.jpg`). Cut stems (eucalyptus, bouquet) get no cast (1k / 7k px) — nothing touches the floor, acceptable. Relight: fern lightmap is bottom-bright (T-B −8/+24%) but reads fine; clip ≤ 0.20%. | — | production-ready |
| textile | 5 | 5 | — | Fringe and sheer curtains intact; sheer is 3% partial (treated as opaque white — fine on white). FJÄDRAR relight clip 0.00%, p01 208 → 182. | `highlights auto` keeps the white cushion flatter if wanted | production-ready |
| tall | 4 | 4 | relight (1) | Framing 3192–3193 px; TÅGARP is 620 px wide in the frame (spec, not a fault). Base-only shadows. TÅGARP relight blows the uplighter shade: clip 0.00% → 10.70% (p90 248 → 254). | `highlights auto` → 0.00% | production-ready with `highlights auto` |
| small | 7 | 7 | — | All framed 3189–3194 px, shadows under. GLADELIG relight clip 0.23%, FÄRGRIK 0.00%. | — | production-ready (control) |
| lit | 7 | 3 | shadow (4) | Mattes fine on all 7 (frosted, paper, open weave). The four hanging pendants (VINDKAST, SINNERLIG, STOCKHOLM 2025, GULLSUDARE) get a floor-contact cast 0.44–0.71 widths right under a lamp on a cord. VARMBLIXT relight darkens the right side (p01 40 → 33), fine. | none: the shadow wrapper has no off switch and the preset is per group | needs new work (hanging-item rule: no cast) |
| dark | 4 | 4 | relight (1) | Run separately after the main pass (8 Photoroom + 2 Gemini calls). Framing 3149–3193 px, margins ≥ 402, cast behind-right 4/4 (0.19–0.65 widths). Partial alpha 3.5–10.3% (NORDVIKEN's slatted back). Relight at 0.25: no recess crush — NORDVIKEN p01 35 → 32, VEDBO p01 32 → 29 — so `shade` is not needed at this strength. VEDBO (dark seat on pale birch frame) clips 0.00% → 2.23% on the legs, p90 187 → 212. | `highlights auto` + `shade 0.65` → VEDBO clip 0.00%, p90 187; NORDVIKEN unchanged. | production-ready; `highlights auto` for dark-on-light-wood pieces |

### Ranked

Production-ready as is (default opaque path, HD matte, `long` shadow): **legs, small, textile, plant, glassware
(render-only), offwhite, dark** — 45/45 on white. offwhite only because Photoroom reframes; the plate stage contributes
nothing there.

Production-ready with an existing knob: **white, tall, reflective** (17/17 on white) with `highlights auto` in
their group.json — the default `on` clips chrome (8%) and lit shades (11%) and lifts near-white fabric to the
ceiling. `open` is 5/7 the same way.

Fixable with a small change that already exists in the wrapper: **flat, fur** and the bath mat in white — wire
`subjectPose` (`flatlay`) into group.json / the shadow presets. Measured: `flatlay` gives the thin contact shadow
a top-down rug should have; `short` does not.

Needs new work:
- **lit, hanging sub-type** (4/7): a "no cast shadow" option for items that hang (pendants, hanging plants).
- **open, thin white frames** (2/7): Photoroom returns no shadow for EKRAR / RIGGA under either preset.
- **reflective mirrors** and **wire/open products on non-white backgrounds**: the matte alpha is partial across
  the mirror face (91–98%) and the wire bodies (36–52%); white hides it, grey will not.
- **plate on off-white sources**: detect on contrast, not absolute luminance, before mixed catalogs arrive.

Not measured here: the relight on the remaining 60 SKUs, and any non-white background.
