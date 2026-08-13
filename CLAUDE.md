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
- `src/cutout.mjs` / `src/photoroom.mjs` — Photoroom removeBackground / generateShadow.
- `src/gemini.mjs` — Gemini relight (lighting map). Read the comment on `IMAGE_SIZE` before touching it.
- `src/shadow-patch.mjs` + `scripts/exp_*.mjs` — EXPERIMENTS, separate from the pipeline.
  They write only to `outputs/experiments/`. Do not wire them into the pipeline unprompted.

## Run

```
npm run pipeline                                   # all SKUs, white bg
npm run pipeline -- --skus PE1016720               # subset
npm run pipeline -- --bg E8E8E8 --out outputs/finals_gray --sheet outputs/contact_sheet_gray.jpg
npm run pipeline -- --shadow short                 # grounding-shadow preset (default: long)
npm run pipeline -- --group group_glass            # only inputs/group_glass/
npm run pipeline -- --no-relight                   # skip Gemini; compositing + shadow only (no GEMINI_KEY needed)
npm run pipeline -- --transparent --group group_glass   # clear-glass composite (white bg only)
npm run pipeline -- --render-only --group group_glass    # very-clear glass: pure Photoroom render (white bg only)
npm run pipeline -- --no-cache --skus PE1016720          # ignore all caches; regenerate every stage from scratch
npm run pipeline -- --debug --skus PE1016720             # log every API request/response + save every stage's I/O images
```

### Per-group config (`inputs/<group>/group.json`)

Each category folder may hold a `group.json` that sets its defaults, so a plain `npm run pipeline`
renders every group correctly in one pass (no remembering flags). Keys (all optional):
`{ "mode": "opaque|transparent|render-only", "strength": 0.08, "shadow": "long|short", "bg": "FFFFFF", "relight": true }`.
Resolution precedence per SKU: **explicit CLI flag > group.json > built-in default** (mode opaque,
strength 0.25, shadow long, bg FFFFFF, relight on). `--mode` is the CLI form of `mode` (the old
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
one — delete `outputs/work/<sku>/final*` to force a re-render in the other mode.

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

1. **One shared frame via `padding: 0.10`.** Matte and shadow are both generated at 4000² with
   `padding: 0.10`; Photoroom pads around the *product*, so both frame it identically (~6 px) and
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
   `final<suffix>_<bg>.jpg` (suffix = shadow preset, `long` = empty). Delete a file to regenerate
   that stage; runs skip SKUs whose final exists. Photoroom 429 stops the run — re-run to resume.
7. **Photoroom API:** dotted form fields (`shadow.*`, `background.color`, `export.format`); let
   FormData set the Content-Type. Sandbox keys are rate-limited 60/min.

## Secrets

`.env` (never committed): `PHOTOROOM_KEY`, `GEMINI_KEY`. Copy `.env.example`.
