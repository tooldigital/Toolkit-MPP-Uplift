# MPP Uplift Pipeline

Takes a flat IKEA Main Product Picture (product on clean white) and produces an uplifted
4000×4000 image — gentle front-left lighting and a neutral cast shadow — with no manual
retouching.

## Setup

```
npm install
cp .env.example .env      # add PHOTOROOM_KEY and GEMINI_KEY
```

Put input images in `inputs/` (one product per file, e.g. `PE1016720.jpg`), on clean white.

## Run

```
npm run pipeline                       # all inputs, white background
npm run pipeline -- --skus PE1016720   # one (or a few, comma-separated)
npm run pipeline -- --strength 0.4     # stronger relight (default 0.25 = gentle)

# any background color — subject decontaminates onto it, cast shadow carried over.
# use --out / --sheet so a non-white run doesn't overwrite the white deliverables:
npm run pipeline -- --bg E8E8E8 --out outputs/finals_gray --sheet outputs/contact_sheet_gray.jpg
```

Outputs:
- `outputs/finals/<sku>.jpg` — finished images, flat folder (white background)
- `outputs/finals_gray/<sku>.jpg` — light-gray background set
- `outputs/contact_sheet.jpg` / `outputs/contact_sheet_gray.jpg` — all finals on one sheet
- `outputs/work/<sku>/` — per-SKU intermediates (`matte.png`, `shadow.jpg`, `relit.jpg`), cached

Composites cache per background (`final_<bg>.jpg`), so switching `--bg` regenerates instead of
reusing a stale composite. Re-runs skip finished SKUs. If Photoroom rate-limits (429), the run
stops cleanly — just re-run to resume.

## How it works (per SKU)

1. **Plate** (`src/plate.mjs`) — detect the subject, scale to ≤3200 px and center it on a
   4000² canvas (400 px margin, brief spec).
2. **Matte** (`src/cutout.mjs`, Photoroom) — clean product cutout with a sharp edge.
3. **Shadow** (`src/photoroom.mjs`, Photoroom `generateShadow`) — product + neutral cast
   shadow, light from front-left. This is the base; its shadow is used untouched.
4. **Relight** (`src/gemini.mjs`, Gemini at temperature 0) — its grayscale is a low-frequency
   lighting map.
5. **Composite** — the crisp original subject (from the matte) is composited over the shadow
   base with the matte alpha. Matte and shadow share the exact frame (both `padding:0.0838`), so
   it's a straight blend — no alignment. The subject is kept on straight alpha, so its edge
   decontaminates onto any `--bg`; the cast shadow is carried onto that background as a
   proportional darkening.

## Config

| Flag | Default | Meaning |
|---|---|---|
| `--strength` | `0.25` | how much of the Gemini lighting swing is applied (gentle) |
| `--bg` | `FFFFFF` | output background hex (any color) |
| `--skus` | all | comma-separated SKU list |
| `--shadow` | `long` | shadow preset: `long` (directional, dramatic) or `short` (soft grounding) — cached separately per preset |
| `--out` | `outputs/finals` | output folder for finals |
| `--sheet` | `outputs/contact_sheet.jpg` | contact-sheet path |

If a shadow comes out wrong on one SKU (Photoroom is non-deterministic — occasionally a leg's
shadow goes the wrong direction), delete that SKU's `outputs/work/<sku>/shadow*.jpg`, `relit*.jpg`
and `final*.jpg` and re-run just that SKU.

## Experiments (not part of the pipeline)

`scripts/exp_*.mjs` + `src/shadow-patch.mjs` are side experiments that write only to
`outputs/experiments/`. Current state: Gemini "improve this shadow crop" (patch mode) is a dead
end — the model erases shadows; Gemini shadow **harvest** (full-scene generation, keep only the
shadow under the real product) works well and is a candidate alternative shadow source.

Requires: Node ≥20, `sharp`, `@google/genai`. Photoroom + Gemini API keys (see `.env.example`).
