# Sofas — uplifted finals on F7F7F7, three relight strengths

12 sofa SKUs, one product category, rendered three times at three relight strengths so you can pick
the look. Everything else is identical across the three sets: same sources, same cutout, same cast
shadow, same F7F7F7 background, same 4000×4000 output. **Only the relight amount changes.**

## Pick a look

| folder | strength | measured brightness gradient across the product |
|---|---|---|
| `relight_008/` | 0.08 | 4.6% ± 0.8 (subtle — barely reads as directional) |
| `relight_025/` | 0.25 | 14.4% ± 2.6 (default — recommended) |
| `relight_040/` | 0.40 | 23.1% ± 4.2 (strong — visible form, risks looking lit) |

`compare_relight_strengths.jpg` — all 12 sofas × all 3 strengths in one grid. Start here.

## Two cutout/framing variants, each at all three strengths

| set | cutout | framing |
|---|---|---|
| `relight_008/025/040/` | standard | subject reframed to fill the frame minus 10% padding → product ~3190 px |
| `relight_008/025/040_hd_noplate/` | **HD** (`pr-hd-background-removal`) | source's own framing kept → product 2436–3067 px |

`compare_relight_strengths_hd_noplate.jpg` — the same 12 × 3 grid for the HD variant.
`compare_hd_noplate_vs_standard.jpg` — native-resolution edge crops, standard vs HD, on the four
SKUs with the finest edges (thin metal/black legs, white slipcover hem).

Trade-off, measured rather than guessed. HD gives a cleaner alpha edge, and the no-plate framing
avoids enlarging the subject. But it also hands framing back to the source photo, and the sofas were
not all shot at the same scale — so the product size varies (2436–3067 px) where the standard path
normalises every SKU to ~3190 px, and cast-shadow reach loosens from **0.63 ± 0.00** product widths
to **0.71 ± 0.07**. For a category grid, that consistency is usually worth more than the edge gain:
**the standard sets are still the recommendation.** The HD sets are here so you can judge the edges
yourself at 100%.

## What's in each folder

```
relight_XXX/  and  relight_XXX_hd_noplate/
  finals/               12 × 4000×4000 JPEG deliverables, background F7F7F7
  contact_sheet.jpg     all 12 finals at a glance
  qc_consistency.jpg    row 1 final · row 2 isolated cast shadow · row 3 lighting map
  qc_consistency.txt    the numbers behind it, per SKU + spread
  qc_texture.jpg        row 1 source crop · row 2 final crop · row 3 difference ×4
  qc_texture.txt        the numbers behind it, per SKU + spread
```

`qc_texture` is present for the three standard sets only. On the HD/no-plate renders the sheet's
automatic source↔final alignment does not lock reliably, so those numbers would be measurement
noise rather than a result; the sheet is omitted instead of shipped misleading.

## How to read the QC sheets

**`qc_consistency`** answers *does the whole category agree?* Row 2 knocks the product out and shows
only the cast shadow, contrast-boosted — the same wedge, same angle, same length on all 12. Row 3 is
the lighting gradient with product detail blurred away — bright top-left falling to bottom-right on
all 12, i.e. one consistent front-left key light. At every strength: key light upper-left 12/12,
shadow to the right 12/12, shadow reach 0.63 ± 0.00 product widths.

**`qc_texture`** answers *was the product itself altered?* A detail-dense 560² window per sofa at
native resolution, source vs final. Product pixels come from the cutout's original pixels, never
redrawn — high-pass correlation 0.84–0.93 on the SKUs that register cleanly.

Two caveats, stated plainly: the finals carry ~0.85× the high-frequency energy of a lanczos upscale
of the source, because the framing step upscales most of these sofas ~1.66× (the source photos are
2000², the deliverables 4000²) — the texture is the same texture, but it is not untouched. And on
PE1032801 / PE1033680 the texture sheet's alignment search fails; those two columns are measurement
noise, not defects in the finals. Their `qc_consistency` columns are unaffected.

## Sources

IKEA public product images. `inputs/group_sofa/manifest.json` in the repo records SKU, model name,
product page and image URL for each. Ten are 2000² (the CDN maximum for those assets); PE979531 and
PE989302 are 4000². Deliverables are 4000² in all cases.
