# MPP Uplift Pipeline

Input: flat IKEA product photo on white. Output: 4000×4000 uplifted image — crisp original product,
gentle front-left relight, neutral cast shadow, 400 px margin. No manual retouching.

Runner: [`scripts/run_pipeline.mjs`](../scripts/run_pipeline.mjs). One SKU at a time, resumable, cached.

## Key invariant

Matte and shadow are both generated at `padding: 0.10`, 4000×4000. Photoroom pads around the **product**
(→ 400 px margin) and lets the shadow fall into the margin, so `removeBackground` and `generateShadow`
frame the product identically (bbox match within ~6 px). Same frame → the composite is a straight per-pixel
blend, no alignment/resampling/dilation.

Do **not** use `outputSize: originalImage` for output — it fits the product edge-to-edge (no margin) and
clips the shadow.

## Stages (per SKU)

| # | Stage | Code | In → Out |
|---|-------|------|----------|
| 1 | Plate | `src/plate.mjs · makePlate` | original.jpg → `plate` (subject scaled so longest side ≤3200, centered on 4000² white) |
| 2 | Matte | `src/cutout.mjs · cutout` | plateWhite → `matte.png` (Photoroom `removeBackground`, 4000², padding 0.10) |
| 3 | Shadow | `src/photoroom.mjs · generateShadow` | plateWhite → `shadow.jpg` (product + cast shadow, 4000², padding 0.10) |
| 4 | Relight | `src/gemini.mjs · generateShadowGemini` | shadow.jpg → `relit.jpg` (Gemini 3 Pro, temp 0, 4K) |
| 5 | Composite | `scripts/run_pipeline.mjs` | matte + shadow + relit → `final.jpg` |

**[2] Matte** — `removeBackground` returns the *original* product pixels + a crisp alpha, so `matte.png` is
both the mask and the subject-pixel source in [5]. Photoroom is used (not a local model) because BiRefNet
fails on fur/glass.

**[3] Shadow** params (standing default): `mode ai.auto-with-overrides, softness 0.6, intensity 0.55, spread
long, direction behindRight, subjectPose upright`. Supplies the cast shadow + background.

**[4] Relight** — used as a grayscale **lighting map only**, never as pixels. Input is the shadow base (so
the prompt's "product with a cast shadow" matches the image). `PREPROCESS.maxDim = 4000` must equal the 4K
output size, else the model tiles/hallucinates the background.

**[5] Composite** — matte and shadow share the frame, so:
```
a        = matte alpha
meanGray = alpha-weighted mean of lightmap over the product
factor   = 1 + ((lightmap − meanGray) / 128) · strength
final    = subject·factor·a + shadow·(1 − a)     # clamped 0..255
```
`a≈1` → crisp original subject, gently relit. `a≈0` → cast shadow + background, untouched.

## Parameters

| Param | Default | Stage | Meaning |
|---|---|---|---|
| frame | 4000 | plate | canvas size |
| maxSubject | 3200 | plate | longest subject side (→ 400 px margin) |
| padding | 0.10 | matte, shadow | Photoroom pads around the product; matte & shadow agree |
| shadow.softness / intensity / spread | 0.6 / 0.55 / long | shadow | standing defaults |
| shadow.direction / subjectPose | behindRight / upright | shadow | light front-left |
| strength | 0.25 | composite | relight amount (gentle) |
| bg | FFFFFF | shadow | background hex |

## Run

```
node --env-file=.env scripts/run_pipeline.mjs [--skus a,b] [--bg FFFFFF] [--strength 0.25]
```
Skips finished SKUs; stops on Photoroom 429 (re-run to resume). Outputs: `outputs/finals/<sku>.jpg` (flat),
`outputs/contact_sheet.jpg`, intermediates cached under `outputs/work/<sku>/`.
