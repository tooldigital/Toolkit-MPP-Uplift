# MPP Uplift Pipeline

Node ≥20, ESM, sharp + Photoroom (`/v2/edit`) + Gemini (`gemini-3-pro-image-preview`).
Takes flat IKEA product photos (`inputs/<sku>.jpg`, on white) → 4000×4000 uplifted finals
(crisp product, gentle front-left relight, neutral cast shadow, 400 px margin).

Read `docs/pipeline.md` for the full stage-by-stage spec. `README.md` has setup + run commands.

## Layout

- `scripts/run_pipeline.mjs` — THE pipeline. One SKU at a time, cached, resumable.
- `src/plate.mjs` — subject → centered 4000² canvas (plate). `makePlate` detects the subject by
  LUMINANCE threshold — opaque-only; on clear glass it crops off bright edges/clips. Glass modes use
  `squarePlate` instead (no detection: `contain`-fit the whole source on white, let Photoroom reframe).
- `src/cutout.mjs` / `src/photoroom.mjs` — Photoroom removeBackground (HD by default, `--no-hd` to opt out) / generateShadow.
- `src/gemini.mjs` — Gemini relight (lighting map). Read the comment on `IMAGE_SIZE` before touching it.
- `src/shadow-patch.mjs` + `scripts/exp_*.mjs` — EXPERIMENTS, separate from the pipeline.
  They write only to `outputs/experiments/`. Do not wire them into the pipeline unprompted.

## Run

```
npm run pipeline                                   # all SKUs, white bg
npm run pipeline -- --skus PE1016720               # subset
npm run pipeline -- --bg E8E8E8 --out outputs/finals_gray --sheet outputs/contact_sheet_gray.jpg
npm run pipeline -- --shadow short                 # grounding-shadow preset (default: long)
npm run pipeline -- --subject-pose flatlay --group group_flat --skus PE419173,PE700145   # top-down items: thin contact shadow (default: upright)
npm run pipeline -- --group group_glass            # only inputs/group_glass/
npm run pipeline -- --no-relight                   # skip Gemini; compositing + shadow only (no GEMINI_KEY needed)
npm run pipeline -- --transparent --group group_glass   # clear-glass composite (white bg only)
npm run pipeline -- --render-only --group group_glass    # very-clear glass: pure Photoroom render (white bg only)
npm run pipeline -- --no-cache --skus PE1016720          # ignore all caches; regenerate every stage from scratch
npm run pipeline -- --no-hd --skus PE1016720             # standard (non-HD) Photoroom removal; HD is the default
npm run pipeline -- --debug --skus PE1016720             # log every API request/response + save every stage's I/O images
```

### Per-group config (`inputs/<group>/group.json`)

Each category folder may hold a `group.json` that sets its defaults, so a plain `npm run pipeline`
renders every group correctly in one pass (no remembering flags). Keys (all optional):
`{ "mode": "opaque|transparent|render-only", "strength": 0.08, "shadow": "long|short", "subjectPose": "upright|flatlay", "bg": "FFFFFF", "relight": true, "highlights": "on|off|auto", "exposure": 1, "shade": 1 }`.

`subjectPose` (CLI `--subject-pose upright|flatlay`, default `upright`) is Photoroom's
`shadow.subjectPoseOverride`, applied to whichever `shadow` preset is selected. `upright` anchors the
cast shadow to a standing object; a top-down item (rug, bath mat, sheepskin) rendered upright gets a
standing-panel shadow reaching ~0.7 widths to the right, and `--shadow short` does not fix it
(measured 2026-10-15, `docs/categories.md`). `flatlay` gives the thin contact shadow such items should
have. Cached as `_flatlay` on `shadow`, `relit` and `final` (upright is unsuffixed, so existing caches
stay valid). group.json is per GROUP — there is no per-SKU override — so a group that mixes top-down
and angled items (`group_flat`: LOHALS/TOFTBO/MARKBLÅMME top-down, OSTBIT/APTITLIG angled) stays
`upright` in its group.json and the top-down SKUs are re-run with `--skus ... --subject-pose flatlay`.
`highlights` (CLI `--highlights on|off|auto`) controls the BRIGHT half of the lighting map; the dark
half always applies at full `strength`. The relight is multiplicative, so the bright half needs
headroom a light product may not have — white fabric already sits at 230-250 and `f > 1` just drives
it into the ceiling (measured: UPPLAND white went from 0.01% of source pixels at ≥254 to 12.4% of
final pixels at strength 0.25). `on` (default) = both halves, right for mid/dark goods. `off` =
shading only, `f ≤ 1`, lit side stays exactly the source pixels (`--shade-only` is an alias; cached
`final*_s_*`). `auto` = scale the bright half per SKU by the product's measured headroom, so beige
gets most of the lift and near-white gets almost none, with no hand-labelling (cached `final*_ha_*`).
Auto measures the **p90** of the product's max channel, not p99 — on beige goods p99 is set by a few
specular highlights and scored a mid-beige sofa the same as a white one. See `headroomScale()`.
Auto takes the SMALLER of a body-wide and an EDGE-BAND headroom (product pixels within 3 px of the
alpha boundary). Studio shots carry rim light, so the edge runs 15-20 levels hotter than the body;
lifting on the body number alone pushed FINNALA's edge p99 to 252 against a 247 backdrop and its
arms lost their outline. Measured lifts: STOCKHOLM natural 1.00, LILLESÄTER off-white 0.56,
UPPLAND white 0.32, STOCKHOLM 2025 beige 0.28, FINNALA beige 0.20, HYLTARP natural 0.12 — 0.00% of
product pixels at >=254 on all six, vs up to 12.4% before.

`shade` (CLI `--shade 0.65`, default 1) scales the DARK half of the lightmap — the mirror of
`highlights`. `strength` moves both halves together, so raising it for modelling also deepens the
shaded side; on a product with a genuinely dark recess that crushes (STOCKHOLM 2025's under-frame
void hit p01 72 at strength 0.55). Lower `shade` to keep the highlight modelling and open the
shadows back up; it ships at 0.65 there (p01 72 -> 83). Cached as `_sh<nn>`.

`exposure` (CLI `--exposure 0.97`, default 1) is a flat multiplier on the PRODUCT only — never the
backdrop or the cast shadow — applied before the highlight shoulder. It is not a relight knob: the
lightmap only redistributes light across the product, so a subject that is uniformly too bright for
the backdrop cannot be fixed by `highlights` at any setting. STOCKHOLM 2025 beige ships at 0.97
(body p90 242 -> 236 against a 247 bg). Cached as `_e<nnn>`. Use sparingly.
Resolution precedence per SKU: **explicit CLI flag > group.json > built-in default** (mode opaque,
strength 0.25, shadow long, subjectPose upright, bg FFFFFF, relight on). `--mode` is the CLI form of `mode` (the old
`--transparent`/`--render-only` flags still work). Configs are validated up front (bad mode/shadow,
or a non-white bg with a white-bg-only mode, fails the run before any work). Committed:
`group_glass/group.json` = render-only; `group_plush/group.json` = opaque, strength 0.08;
`group_sofa/group.json` = opaque, strength 0.25 (built-in defaults).

### `inputs/group_sofa/` — 12-SKU single-category consistency set

Ten IKEA sofas pulled from the public product CDN (`inputs/group_sofa/manifest.json` records SKU,
model name, product page and image URL for each), plus the two sofas that already lived in
`group_all` (PE979531, PE989302 — copied, so they render in BOTH groups). 2000² for the fetched
ten — that is the CDN maximum for those assets (`?imwidth=4000` returns 2000²), 4000² for the two
from `group_all`; finals are true 4000² either way, the plate upscales to canvas.
Purpose: prove the uplift is CONSISTENT across a category, not just good on one hero shot.

`scripts/qc_sofa_consistency.mjs` measures that from the cached stages (no API calls):
```
node scripts/qc_sofa_consistency.mjs --group group_sofa --strength 0.25
```
It plane-fits the applied relight (`f = 1 + ((lm-mean)/128)*strength`) over the product pixels and
isolates the cast shadow (shadow render < 245 where matte α < 0.05), then prints a per-SKU table +
spread stats and writes `outputs/qc_group_sofa_consistency.jpg` (row 1 final, row 2 isolated shadow,
row 3 lighting map). Current result: key light upper-left on 12/12, shadow to the right on 12/12,
shadow reach 0.63 ± 0.00 product widths, relight 14.4% ± 2.6 edge-to-edge.

Shipped on BOTH backgrounds — `outputs/finals/group_sofa/` (FFFFFF, the group.json default) and
`outputs/finals_sofa_f7f7f7/group_sofa/` (F7F7F7, to match the plush sets):
```
npm run pipeline -- --group group_sofa --bg F7F7F7 --out outputs/finals_sofa_f7f7f7 \
  --sheet outputs/contact_sheet_sofa_f7f7f7.jpg
```
bg only affects the final composite, so that pass reuses every cached stage — no API calls, and the
QC numbers are identical for both sets (they are measured on matte/shadow/relit, upstream of bg).

`inputs/` may be flat OR split into category subfolders (`inputs/group_all/`, `inputs/group_glass/`).
Inputs are collected recursively and **finals mirror the input structure** — a SKU in
`inputs/group_glass/` lands in `outputs/finals/group_glass/`, with a per-category
`contact_sheet_<group>.jpg`. `--group <name>` limits a run to one category subfolder.

`--no-relight` skips stage 4 entirely (no Gemini call, product kept flat, relight factor = 1);
the Photoroom cast shadow and compositing still run. NOTE: the work-cache final key does NOT
encode relight on/off, so switching modes for a SKU that already has a cached final reuses the old
one — delete `outputs/work/<sku>/final*` to force a re-render in the other mode. `strength` IS in
the key (`_st<nnn>`, omitted at the 0.25 default) — it was not until 2026-08-07, and a re-run at a
new `--strength` silently returned the previously cached composite.

`--no-cache` ignores ALL cached intermediates/finals and regenerates every stage from scratch
(re-fetches Photoroom + Gemini). Stages are still written to `outputs/work/`, so a later normal run
resumes as usual. Without this flag the pipeline is cache-first (see invariant 6) — the usual way to
force one stage is to delete its cached file, not to disable caching globally.

`--debug` turns on full I/O logging (for debugging API behavior), off by default. It writes:
- a JSONL run log `outputs/debug/run-<ts>.jsonl` — one line per event: every API **request**
  (endpoint, all params — shadow settings, Gemini model/imageSize/temperature/prompt — and input
  byte size) and **response** (ok, HTTP timing `ms`, output byte size), plus per-stage cache
  hit/miss and the final composite params (`relightMean`, mode, bg, strength). The logging layer
  lives in `src/debuglog.mjs`; the API modules call `logCall()`, so requests/responses are captured
  at the HTTP boundary.
- the input+output IMAGE of every stage under `outputs/work/<sku>/debug/`, numbered in order:
  `00_input_source`, `01_plate_input` (bytes sent to both Photoroom calls), `02_shadow_output`,
  `03_matte_output`, `04_relight_input` (bytes sent to Gemini), `05_relight_output`,
  `99_final_output`. Only the stages a given mode runs are written (e.g. `--render-only` writes
  00–02 + 99). Everything under `outputs/` except finals is gitignored.

`--transparent` is for CLEAR products (glass). The default composite `subj*a + bg*(1-a)` assumes
opaque product pixels; on clear glass the alpha is partial across the whole body and Photoroom's
color-decontamination there is dark, so `subj*a` paints hard dark rims (the "fried" look). In this
mode the product color comes from the crisp matte only where near-opaque (`k = smoothstep(0.85,1,α)`)
and from Photoroom's shadow RENDER elsewhere (`out = subj*k + base*(1-k)`) — the render handles
transparency correctly. WHITE-BG ONLY (the render bg can't be recolored); cached as `final_t_*`.

`--render-only` is for VERY clear glass, where even `--transparent` fries. `--transparent` still
trusts the crisp matte where `α ≥ 0.85`, and glass rims/lids/clips are near-opaque, so
removeBackground's edge decontamination there still paints a fried rim. This mode drops the matte
term ENTIRELY: the final IS Photoroom's shadow render (`out = base`) — no matte, no relight (no
Gemini call). The render handles transparency with no decontam rims. WHITE-BG ONLY; cached as
`final_r_*`. Mutually exclusive with `--transparent`. This is the current path for `group_glass`.

Deliverables live in `outputs/finals/` (white) and `outputs/finals_gray/` — both are COMMITTED.
Intermediates (`outputs/work/`) and experiments are gitignored. After changing finals, rebuild the
contact sheet(s) and commit both sets.

## Invariants — each one was learned the hard way; do not re-break them

1. **One shared frame via `PADDING`** (`0.10` plated, `0.0838` with `--no-plate`). Matte and shadow
   are both generated at 4000² with the single `PADDING` constant in `run_pipeline.mjs`. What
   Photoroom pads is its referenceBox, so the value depends on the framing mode. Plated (default):
   padding is a plain fraction of the output per side, subject box = `4000 * (1 - 2*padding)`, the
   same on 4000² and 2000² inputs (measured 2026-10-15: 0.10 → 3200 px / 400 px; 0.0838 → 3328-3330 px /
   335-336 px, which breaks the spec; shipped finals at 0.10 measure 3195-3202 px / 401-407 px).
   `--no-plate` (referenceBox=originalImage): Photoroom fits the whole source image, so the subject box
   is `fill * 4000 * (1 - 2*padding)` where fill = subject/source; the CDN chairs fill ~0.96, which is
   the `3838 - 7675*padding` fit behind 0.0838 (12 chairs 401-407 px; PE870153 re-measured 3194 px /
   403 px on 2026-10-15). 0.0838 is only right for sources with that fill. Between 2026-08-10 and
   2026-10-15 the plated path also ran at 0.0838 and was 65 px under spec.
   Never let the two calls use different values.
   Photoroom pads around the *product*, so both frame it identically (~6 px) and
   the composite is a straight per-pixel blend. NO alignment, resampling, bbox-matching, dilation,
   or feathering in the composite — every one of those was tried and caused halos, ghosts, cropped
   shadows, or gaps. Never use `outputSize: originalImage` for output (full-bleed, kills margin + shadow).
2. **Product pixels come from the matte** (`removeBackground` returns the original pixels + crisp
   alpha). Never from Photoroom's shadow render (soft) and never from Gemini (redrawn).
   EXCEPTION: `--transparent` mode (clear glass) deliberately sources the see-through body from the
   shadow render — the crisp matte's dark decontamination fries glass edges there. The invariant
   holds for opaque products (the default path); transparent mode is white-bg-only and opt-in.
   `--render-only` (very-clear glass) goes further and drops the matte term entirely (`out = base`,
   pure Photoroom render) — even `--transparent`'s near-opaque matte blend fries glass rims/lids.
3. **Gemini output is never pixels.** The relight is consumed as a low-frequency lighting map:
   generated at **2K, temperature 0**, upscaled to 4000, then `blur(20)`. At temp 0, large flat
   regions degenerate into checkerboard/tile artifacts at 4K (A/B verified: 4K+temp0 tiles,
   4K+temp0.7 clean, 2K+temp0 clean). Keep 2K+temp0; if you ever need 4K, raise temperature.
4. **Cast shadow = Photoroom `generateShadow`.** Never hand-roll a procedural shadow (tried; looks
   fake). Photoroom is non-deterministic: on multi-leg furniture a leg's shadow occasionally goes
   the wrong way — fix by deleting that SKU's `outputs/work/<sku>/shadow*.jpg` (+ relit + finals)
   and re-running. The experimental Gemini shadow-harvest (`src/shadow-patch.mjs`) is a promising
   alternative; patch-mode ("improve this shadow crop") is a dead end — Gemini erases shadows.
5. **Finals are 4000², native res.** Never downsample deliverables.
6. **Caching:** `outputs/work/<sku>/` holds `matte.png`, `shadow<suffix>.jpg`, `relit<suffix>.jpg`,
   `final<suffix>_<bg>.jpg` (suffix = shadow preset then subject pose: `long`/`upright` = empty,
   e.g. `shadow_short_flatlay.jpg`). Delete a file to regenerate
   that stage; runs skip SKUs whose final exists. Photoroom 429 stops the run — re-run to resume.
7. **Photoroom API:** dotted form fields (`shadow.*`, `background.color`, `export.format`); let
   FormData set the Content-Type. Sandbox keys are rate-limited 60/min.

## Secrets

`.env` (never committed): `PHOTOROOM_KEY`, `GEMINI_KEY`. Copy `.env.example`.
