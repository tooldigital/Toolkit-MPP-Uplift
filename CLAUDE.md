# MPP Uplift Pipeline

Node ≥20, ESM, sharp + Photoroom (`/v2/edit`) + Gemini (`gemini-3-pro-image-preview`).
Takes flat IKEA product photos (`inputs/<sku>.jpg`, on white) → 4000×4000 uplifted finals
(crisp product, gentle front-left relight, neutral cast shadow, 400 px margin).

Read `docs/pipeline.md` for the full stage-by-stage spec. `README.md` has setup + run commands.

## Layout

- `scripts/run_pipeline.mjs` — THE pipeline. One SKU at a time, cached, resumable.
- `src/plate.mjs` — subject → centered 4000² canvas (plate).
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
```

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
