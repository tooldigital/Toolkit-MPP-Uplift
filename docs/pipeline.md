# MPP Uplift Pipeline

Input: flat IKEA product photo on white. Output: 4000×4000 uplifted image — crisp original product,
gentle front-left relight, neutral cast shadow, 400 px margin. No manual retouching.

Runner: [`scripts/run_pipeline.mjs`](../scripts/run_pipeline.mjs). One SKU at a time, resumable, cached.

## Key invariant

Matte and shadow are both generated at `padding: 0.10` (plated; `0.0838` with `--no-plate`), 4000×4000. Photoroom pads around the **product**
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
the prompt's "product with a cast shadow" matches the image). Generated at **2K, temperature 0**
(`IMAGE_SIZE = "2K"`, input downscaled to 2048). Why: at **temperature 0**, greedy sampling over large
flat-white regions degenerates into repeating checkerboard/tile artifacts; it manifests at 4K (4× the flat
area) but not at 2K. A/B verified: 4K+temp0 tiles, 4K+temp0.7 clean, 2K+temp0 clean. Temp 0 is required
(deterministic lightmap), so 2K it is — the map is low-frequency by design, so 2K loses nothing. The runner
upscales it to 4000 and **low-passes it** (`blur(20)`) so only the smooth lighting gradient transfers —
never Gemini texture, JPEG noise, or artifact residue. Raising to 4K requires raising the temperature.

**[5] Composite** — matte and shadow share the frame, so:
```
a        = matte alpha                                   # straight, anti-aliased
lightmap = relit.jpg upscaled to 4000² + blur(20)        # low-pass: lighting only, no texture
meanGray = alpha-weighted mean of lightmap over the product
factor   = 1 + ((lightmap − meanGray) / 128) · strength
shadowF  = (a·255 + (1−a)·luminance(shadowBase)) / 255   # cast-shadow darkening; product masked out
final    = subject·factor·a + bg·shadowF·(1 − a)         # clamped 0..255
```
`a≈1` → crisp original subject, gently relit. `a≈0` → `bg` darkened by the cast shadow. Works for any `bg`
hex; with `bg = FFFFFF` the second term reduces to the raw shadow base. The subject is kept on **straight
alpha** (not flattened), so its edge decontaminates onto whatever `bg` is chosen — non-white backgrounds
composite with no dark halo or white fringe.

### Edge handling — no fringing, no feather/erode

Clean edges are structural, not post-processed. There is **no feather, erosion, dilation, or
decontamination step**. They come from:

1. **Shared frame** — matte and shadow register to within ~6 px, so the subject sits exactly over the base's
   product. No misregistration → no halo / double-edge ring (this was the failure mode of every
   align-after-the-fact approach).
2. **Straight anti-aliased alpha** — Photoroom's matte alpha carries sub-pixel edge coverage and the subject
   is kept on straight (non-premultiplied) alpha, so the over-blend `subject·a + bg·shadowF·(1−a)` feathers
   the subject's decontaminated edge into the **chosen background** — clean on white *and* non-white.

## Parameters

| Param | Default | Stage | Meaning |
|---|---|---|---|
| frame | 4000 | plate | canvas size |
| maxSubject | 3200 | plate | longest subject side (→ 400 px margin) |
| padding | 0.10 (plated) · 0.0838 (`--no-plate`) | matte, shadow | Photoroom pads its referenceBox; matte & shadow agree |
| shadow.softness / intensity / spread | 0.6 / 0.55 / long | shadow | standing defaults |
| shadow.direction / subjectPose | behindRight / upright | shadow | light front-left |
| strength | 0.25 | composite | relight amount (gentle) |
| bg | FFFFFF | composite | output background hex (any color; shadow generated on white, recolored here) |
| shadow | long | shadow | preset: `long` (directional) or `short` (soft grounding); cached per preset |

## Run

```
node --env-file=.env scripts/run_pipeline.mjs [--skus a,b] [--bg FFFFFF] [--strength 0.25]
```
Skips finished SKUs; stops on Photoroom 429 (re-run to resume). Outputs: `outputs/finals/<sku>.jpg` (flat),
`outputs/contact_sheet.jpg`, intermediates cached under `outputs/work/<sku>/`.
