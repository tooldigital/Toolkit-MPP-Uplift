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

One SKU overlaps Iman's sets: VEDBO PE638683 is in both `group_dark` and `group_chair`, the same image. The
groups otherwise complement `group_chair` / `group_sofa` (large opaque upholstery, the easy case) and the
empty `group_glass` / `group_plush` folders. The pipeline caches by SKU name, so overlapping SKUs share
stages.

## Axis → expected failure → where it lands in the pipeline

| Group | n | What's hard | Stage at risk | Existing lever | Measured 2026-10-15 (details below) |
|---|---|---|---|---|---|
| glassware | 8 | see-through body, bright rims, sets of overlapping glasses | plate (luminance bbox crops bright edges), matte (partial alpha everywhere → fried rims) | `mode: render-only` / `transparent`, `squarePlate` | **8/8 OK** (render-only). No fried rims, shadow present. Relight (glass prompt) OK on 2/2. |
| fur | 6 | fur silhouette; three items lie flat (BLÅHAJ, GOSIG GOLDEN, sheepskin) | matte (halo at fur edge), shadow (flat items get none — the otter case) | strength 0.08; `docs/plush_f7f7f7.md` band/dehalo experiments | **4/6 OK**. Edges clean on white. 2 flat items (sheepskin, rug) get a standing-panel shadow → shadow stage; needs `flatlay` pose. |
| legs | 8 | 3–4 thin legs, tripod bases, splayed metal legs | shadow (`long` preset sends one leg's shadow the wrong way — invariant 4); thin legs vs ±3 px Photoroom scatter | `--shadow short`; delete + re-run | **8/8 OK**. No wrong-way leg this run; cast behind-right on 8/8. Relight OK on 2/2 (LISABO clip 1.2% → 0.1% with `highlights auto`). |
| white | 6 | near-white product on white (UPPLAND, white mug, bath mat) | plate (threshold 245 misses it), relight (no headroom → clipping), composite (no bg contrast) | `highlights: auto/off`, `exposure` | **6/6 OK** on white. Plate threshold held on all 6. Bath mat: standard matte 97% partial alpha (ghost on grey) → fixed by HD matte (now default); its shadow is a standing card. Relight OK, UPPLAND clip 0.05%. |
| dark | 4 | black furniture, dark upholstery, black candlesticks | relight (shade half crushes recesses), matte (dark decontamination rim) | `shade` | **4/4 OK**. Shadows behind-right, long side 3191–3195 px. No crush at strength 0.25 (NORDVIKEN p01 35 → 32). VEDBO's pale wood legs clip 2.2% under relight → `highlights auto` 0.0%. |
| reflective | 7 | mirror faces, chrome, brushed/polished steel | matte (reflections read as background), relight (speculars fight the lightmap), mirror face ≈ white | none yet | **7/7 OK on white**. Both mirror faces are 91–98% partial alpha in the matte → the backdrop shows through on any non-white bg. Relight blows chrome (bowl clip 8.2%) → `highlights auto` fixes (0.1%). |
| flat | 6 | rugs shown top-down, boards, trays, bath mat | shadow (`subjectPose: upright` is wrong; nothing vertical to anchor a cast shadow) | `subjectPose: flatlay` (a pipeline setting since `a9eab14`) | **2/6 OK** (the two angled boards). 3 top-down rugs get a standing-panel shadow (cast reaches 0.7 widths right); STOENSE standard matte 63% partial (pale cloud) → fixed by HD. `--shadow short` does not fix; `subjectPose: flatlay` does. |
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
`outputs/experiments/catalog_flatlay/`, zoom/QC sheets `outputs/catalog_qc_*.jpg`, logs `outputs/catalog_logs/`. **Committed:** the contact
sheets, QC sheets and logs (~10 MB). **Local only** (on Ariel's machine, ~160 MB): the full-resolution
finals, relight and lever folders.
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

### Metrics

Definitions, so a QC gate can be built from them without reading the results. All on the 4000² frame,
from cached stages, no API calls. `α` = matte alpha 0–255; `luma = 0.299R + 0.587G + 0.114B`; "max channel"
= `max(R, G, B)`.

| Metric | Definition | Spec or observed range | Catches |
|---|---|---|---|
| Subject box | Tight bbox of `α > 128`. Report long side and the four margins. | Spec: long side ≤ 3200, margins ≥ 400. Observed long side 3185–3202 px, margins 399–407 px. | Framing drift, padding errors |
| Partial-alpha share | Among pixels with `α ≥ 5`, the share with `5 ≤ α ≤ 249`. | Observed: solid products 2–10%; wire 36–52%; mirror faces 91–98%; standard-matte failures 63–97% | Matte failures; products that will ghost on a non-white background |
| Cast-shadow area | Pixels where `α < 13` (≈0.05) and `luma(shadow render) < 245`. | Observed 164k–1,020k on grounded items; 1k–56k when the shadow is missing | Missing shadow |
| Shadow offset | (x-centroid of the cast-shadow pixels − x-centre of the subject box) / subject width. Positive = right. | `long` preset, upright: +0.19 to +0.65. Standing-panel artefact on flat items: +0.66 to +0.75 | Wrong pose; wrong direction (negative) |
| Clipped share | Among pixels with `α ≥ 200`, the share with max channel ≥ 254. Compare source matte against final. | Observed after relight with `highlights on`: up to 13.35%; with `auto`: ≤ 1.42% | Blown highlights from relight |
| Tone percentiles | p01, p50, p90 of `luma` over pixels with `α ≥ 200`, source against final. | — | Crushed shadows (p01 falling), lifted whites (p90 rising) |

**No acceptance thresholds have been set.** The ranges above are what this run observed on small
samples. Choosing pass/fail limits is an owner decision (`docs/handoff-backend.md` §8).

Wrong-way leg shadows are not caught by any metric above; the run checked them by eye with
`scripts/qc_chair_shadow_zoom.mjs`.

**The measurement scripts for this run were ad hoc and are not committed.** The committed
`scripts/qc_sofa_consistency.mjs` uses different conventions: it works at 500², uses Rec. 709 luma
(`0.2126R + 0.7152G + 0.0722B`), and models the relight as `1 + ((L − μ)/128)·strength` without
highlights, shade, exposure or the shoulder. Its numbers are not directly comparable to these.

### Per group

| Group | n | OK | Failing stage | Symptom (measured) | Existing lever | Verdict |
|---|---|---|---|---|---|---|
| legs | 8 | 8 | — | bbox 3188–3195 px, cast behind-right 8/8, no wrong-way leg (`qc_chair_shadow_zoom` sheet `outputs/catalog_qc_legs_zoom.jpg`). Relight: SKOGSTA clip 0.00%, LISABO 1.18% (pale wood lifted). | `highlights auto` → LISABO 0.08% | passed on white 8/8 |
| white | 6 | 6 | (matte, standard only) | Plate threshold 245 found every subject (all have edges < 245). ALSTERN bath mat: standard matte alpha spread 0–255 over the whole body (median ≈170; invisible on white, ghosts on grey) — HD matte 1.8% partial. Its shadow is a standing card (cast 0.74 widths right) — see flat. UPPLAND relight: clip 0.05% at `on` (shoulder holds), p01 166 → 143 on the shade side; GULLABERG 0.00%. | HD (default now); `highlights auto` trims the lift (UPPLAND p90 251 → 248) | passed on white 6/6 (bath mat is a flat item, see flat) |
| flat | 6 | 2 | shadow (3), matte-standard (1) | Angled boards OK. Top-down rugs (LOHALS, TOFTBO, MARKBLÅMME) get a standing-panel cast reaching 0.68–0.71 widths to the right. STOENSE standard matte 63% partial (pale cloud through the middle) — HD 1.4%. Relight on MARKBLÅMME blows the cream squares: clip 0.76% → 13.35%. | `--shadow short`: foot shadow, still reads as a standing panel. `subjectPose: flatlay`: thin contact shadow, correct. `highlights auto`: MARKBLÅMME 1.42%. | passed with `subjectPose: flatlay` on the top-down SKUs |
| open | 7 | 5 | shadow (2) | EKRAR and RIGGA (thin white tube frames) get no cast: 3k / 56k shadow px vs 164k–1020k for the rest. Wire bodies (OMAR, RISATORP, EKRAR, RIGGA) 36–52% partial alpha — fine on white, would ghost on grey. Relight OK (OMAR clip 0.78%, RÅSKOG 0.00%). | `--shadow short`: 1k / 15k px, no help. | passed on white 5/7; thin white frames need new work |
| offwhite | 7 | 7 | plate (masked) | `makePlate` bbox = the whole 2000² frame on all 7 (bg 244–246 < threshold 245). Photoroom then detects the product itself, pads it to 3185–3191 px and drops the baked floor shadow: single cast, white bg, no double shadow. LAIVA relight p01 7 → 6 (no crush), NATTJASMIN clip 0.00%. | none needed today; the plate stage is a no-op here and only Photoroom's padding saves it | passed on white 7/7, but only because Photoroom re-detects; the plate should detect on contrast |
| glassware | 8 | 8 | — | render-only: no fried rims, bodies see-through, shadow present (set of 6 and glass block included). Framing not measurable without a matte; left/top margins 401–403 px. Relight with the glass prompt on POKAL / carafe: no visible artefact. | `mode: render-only` (group.json) | passed on white 8/8 |
| fur | 6 | 4 | shadow (2) | Fur edges clean on white (sheepskin edge zoom `outputs/catalog_qc_edges_a.jpg`). ULLERSLEV sheepskin and VOLLERSLEV rug lie flat and get a standing-panel cast (0.66 / 0.75 widths right). Relight at 0.08: DJUNGELSKOG clip 0.07%, sheepskin 0.15%. | same as flat: `flatlay` pose | fixable with the flat fix |
| reflective | 7 | 7 on white | matte (2, latent), relight (1) | LINDBYN / HOVET mirror faces are 98% / 91% partial alpha — the matte treats the reflection as background; on white it passes, on any other bg the backdrop shows through the mirror. AFTONHAJ steel bowl relight: clip 0.00% → 8.23%, the chrome highlight flattens to a plateau. | `highlights auto` → 0.08%, highlight shape kept. Nothing for the mirror alpha. | passed on white 7/7 with `highlights auto`; mirrors need new work for non-white |
| plant | 6 | 6 | — | HD matte keeps fronds and bamboo leaves (zoom `outputs/catalog_qc_edges_b.jpg`). Cut stems (eucalyptus, bouquet) get no cast (1k / 7k px) — nothing touches the floor, acceptable. Relight: fern lightmap is bottom-bright (T-B −8/+24%) but reads fine; clip ≤ 0.20%. | — | passed on white 6/6 |
| textile | 5 | 5 | — | Fringe and sheer curtains intact; sheer is 3% partial (treated as opaque white — fine on white). FJÄDRAR relight clip 0.00%, p01 208 → 182. | `highlights auto` keeps the white cushion flatter if wanted | passed on white 5/5 |
| tall | 4 | 4 | relight (1) | Framing 3192–3193 px; TÅGARP is 620 px wide in the frame (spec, not a fault). Base-only shadows. TÅGARP relight blows the uplighter shade: clip 0.00% → 10.70% (p90 248 → 254). | `highlights auto` → 0.00% | passed on white 4/4 with `highlights auto` |
| small | 7 | 7 | — | All framed 3189–3194 px, shadows under. GLADELIG relight clip 0.23%, FÄRGRIK 0.00%. | — | passed on white 7/7 (control) |
| lit | 7 | 3 | shadow (4) | Mattes fine on all 7 (frosted, paper, open weave). The four hanging pendants (VINDKAST, SINNERLIG, STOCKHOLM 2025, GULLSUDARE) get a floor-contact cast 0.44–0.71 widths right under a lamp on a cord. VARMBLIXT relight darkens the right side (p01 40 → 33), fine. | none: the shadow wrapper has no off switch and the preset is per group | needs new work (hanging-item rule: no cast) |
| dark | 4 | 4 | relight (1) | Run separately after the main pass (8 Photoroom + 2 Gemini calls). Long side 3191–3195 px, margins ≥ 402, cast behind-right 4/4 (0.19–0.65 widths). Partial alpha 3.5–10.3% (NORDVIKEN's slatted back). Relight at 0.25: no recess crush — NORDVIKEN p01 35 → 32, VEDBO p01 32 → 29 — so `shade` is not needed at this strength. VEDBO (dark seat on pale birch frame) clips 0.00% → 2.23% on the legs, p90 187 → 212. | `highlights auto` + `shade 0.65` → VEDBO clip 0.00%, p90 187; NORDVIKEN unchanged. | passed on white 4/4; `highlights auto` for dark-on-light-wood pieces |

### Ranked

"Passed" means every SKU in the group looked right on white and its metrics were in range. Samples are
4–8 SKUs per group; relight was checked on 2 per group.

Passed on white with defaults (opaque path, HD matte, `long` shadow): **legs, small, textile, plant,
glassware (render-only), offwhite, dark**: 45/45. offwhite passes only because Photoroom re-detects the
product; the plate stage contributes nothing there.

**white, tall, reflective**: 17/17 passed the Photoroom-only pass on white. Relight was checked on 2 SKUs
per group: with the default `highlights: on` it clipped chrome (AFTONHAJ 8.2%) and a lit shade (TÅGARP
10.7%); `highlights: auto` brought both to ≤ 0.1%. `auto` is not set in any `group.json`, and it is
untested on the other 11 SKUs of these groups.

Passed with `subjectPose: flatlay` on the top-down SKUs: **flat, fur**, and the bath mat in white.
`flatlay` gives the thin contact shadow a top-down item should have; `short` does not. Wired as a setting
in `a9eab14`; not set in any `group.json`, because `group_flat` mixes top-down and angled items.

Needs new work:
- **lit, hanging sub-type** (4/7): a "no cast shadow" option for items that hang (pendants, hanging plants).
- **open, thin white frames** (2/7): Photoroom returns no shadow for EKRAR / RIGGA under either preset.
- **reflective mirrors** and **wire/open products on non-white backgrounds**: the matte alpha is partial across
  the mirror face (91–98%) and the wire bodies (36–52%); white hides it, grey will not.
- **plate on off-white sources**: detect on contrast, not absolute luminance, before mixed catalogs arrive.

Not measured here: the relight on the remaining 60 SKUs, and any non-white background.

Run settings: commit `b60026f` plus flatlay work, Photoroom shadow model `2026-04-15`, Gemini
`gemini-3-pro-image-preview` at 2K and temperature 0, padding 0.10 plated, HD matte.

## Earlier category sets (Iman, August 2026)

**`group_sofa`**: ten sofas from the IKEA CDN plus PE979531 and PE989302 from the originals. Purpose: show
the uplift is consistent across one category, not just good on one hero shot. Measured with
`scripts/qc_sofa_consistency.mjs` (plane fit of the applied relight over product pixels; cast shadow
isolated as render < 245 where α < 0.05):

| Check | Result |
|---|---|
| Key light upper-left | 12/12 |
| Cast shadow to the right | 12/12 |
| Shadow reach | 0.63 ± 0.00 product widths |
| Relight swing edge to edge | 14.4% ± 2.6 |

Shipped on FFFFFF and on F7F7F7. Those finals were never committed and are not on this machine. Background affects only the
composite, so the F7F7F7 pass reused every cached stage and the QC numbers are identical for both.
Per-sofa tone settings that shipped (PE639439 strength 0.55; PE1033680 strength 0.55, exposure 0.97,
shade 0.65) are recorded only in commit `150483e`; no `group.json` carries them.

**`group_chair`**: eleven armchairs plus PE1016720. `scripts/qc_chair_shadow_zoom.mjs` result: no
wrong-way shadows, all twelve cast right-and-back.

**`group_plush`, `group_glass`**: configs only; their source images and deliverables were not committed.
Plush process: `docs/plush_f7f7f7.md`.
