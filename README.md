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
npm run pipeline -- --bg E8E8E8        # light-gray background instead of white
```

Outputs:
- `outputs/finals/<sku>.jpg` — the finished images, flat folder (easy to browse)
- `outputs/contact_sheet.jpg` — all finals on one sheet
- `outputs/work/<sku>/` — per-SKU intermediates (`matte.png`, `shadow.jpg`, `relit.jpg`), cached

Re-runs skip finished SKUs. If Photoroom rate-limits (429), the run stops cleanly — just re-run to resume.

## How it works (per SKU)

1. **Plate** (`src/plate.mjs`) — detect the subject, scale to ≤3200 px and center it on a
   4000² canvas (400 px margin, brief spec).
2. **Matte** (`src/cutout.mjs`, Photoroom) — clean product cutout with a sharp edge.
3. **Shadow** (`src/photoroom.mjs`, Photoroom `generateShadow`) — product + neutral cast
   shadow, light from front-left. This is the base; its shadow is used untouched.
4. **Relight** (`src/gemini.mjs`, Gemini at temperature 0) — its grayscale is a low-frequency
   lighting map.
5. **Composite** — the shadow base is relit in place, gated by the matte: only the product
   region gets the gentle directional shading; the cast shadow is left exactly as Photoroom
   produced it.

## Config

| Flag | Default | Meaning |
|---|---|---|
| `--strength` | `0.25` | how much of the Gemini lighting swing is applied (gentle) |
| `--bg` | `FFFFFF` | background hex (white for the no-shadow deliverable) |
| `--skus` | all | comma-separated SKU list |

Requires: Node ≥20, `sharp`, `@google/genai`. Photoroom + Gemini API keys.
