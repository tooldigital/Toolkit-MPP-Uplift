# Decision log

Why the pipeline's constants and rules are what they are, in date order. Each entry names the commit
and the evidence. **Measured** means the numbers are in a commit message, code comment or doc in this
repo. **Reconstructed** means the rationale is recorded but the experiment that produced it is not.

Authors: Ariel (A), Iman (I). Compiled 2026-10-15 from `git log` and the docs; owners should confirm
the reconstructed entries.

| # | Date | Decision | Commit | Evidence |
|---|---|---|---|---|
| 1 | 2026-07-01 | Shared frame: matte and shadow both at `padding 0.10`, composite as a straight per-pixel blend | `670ee02` (A) | Reconstructed |
| 2 | 2026-07-01 | Photoroom for matting, not a local model | `670ee02` (A) | Reconstructed |
| 3 | 2026-07-01 | Any background colour via straight alpha plus a shadow factor | `e445d74` (A) | Measured |
| 4 | 2026-07-01 | Wrong shadows are fixed by deleting and re-rendering, plus one manual matte fix | `1ea8da0`, `f970788` (A) | Measured |
| 5 | 2026-07-04 | Gemini relight at 2K, temperature 0, blurred, never pixels | `98cd863`, `eb76ac5` (A) | Measured |
| 6 | 2026-07-04 | Gemini shadow "patch" abandoned; "harvest" kept as an experiment | `342aa6c` (A) | Measured |
| 7 | 2026-07-15 | Two shadow presets, `long` and `short` | `f099978` (A) | Reconstructed |
| 8 | Aug 2026 | Glass modes `transparent` and `render-only`; per-group config | `af781d7` (I) | Measured |
| 9 | 2026-08-10 | HD matte and `--no-plate` framing, both opt-in | `600a3bd` (I) | Measured |
| 10 | 2026-08-10 | Padding 0.10 → 0.0838 | `21c61e3` (I) | Measured, later found input-dependent |
| 11 | 2026-08-10 | Tone controls: shoulder, highlights, shade, exposure; strength in cache key | `21c61e3` (I) | Measured |
| 12 | 2026-08-10 | Automatic per-SKU tuning attempted, not adopted | `150483e` (I) | Measured |
| 13 | 2026-10-15 | Padding split: 0.10 plated, 0.0838 no-plate | `2afe5b1` (A) | Measured |
| 14 | 2026-10-15 | HD matte becomes the default | `b60026f` (A) | Measured |
| 15 | 2026-10-15 | Subject pose `flatlay` as a setting | `a9eab14` (A) | Measured |
| 16 | open | Should the highlight shoulder apply when there is no relight? | — | Measured, undecided |

## 1. Shared frame, no alignment

Photoroom pads around the product it detects, so a matte and a shadow render made with the same
`padding` frame the product identically, within ~7 px. The composite is then a per-pixel blend.
CLAUDE.md records that alignment, resampling, bbox-matching, dilation and feathering were all tried
and produced halos, ghosts, cropped shadows or gaps. The experiments themselves are not in the repo.

## 2. Photoroom over a local matting model

The original spec states BiRefNet failed on fur and glass. No comparison images are committed.

## 3. Any background colour

The subject stays on straight alpha, so its anti-aliased edge blends into whatever colour is chosen.
The cast shadow is carried over as a darkening factor `luma(shadow render) / 255`, masked out where the
product is. On white this reduces exactly to the shadow render. The 22 originals ship on FFFFFF and
E8E8E8.

## 4. Fixing bad shadows by re-rendering

PE1016720's front-left leg shadow pointed the wrong way; the shadow was regenerated (`1ea8da0`).
That became the documented fix for Photoroom's non-determinism: delete the SKU's shadow, relit and
final, and run again. Iman filed the issue with Photoroom support; `scripts/exp_shadow_photoroom_advice.mjs`
tests the two suggestions they gave.

One manual intervention exists in the history: PE235587's matte had a downward spike (a stray "leg")
that was clipped (`f970788`). Production needs a policy for cases like this.

## 5. Gemini at 2K, temperature 0

First diagnosis (`98cd863`): 4K output tiles and hallucinates texture. Corrected root cause
(`eb76ac5`): at temperature 0, greedy sampling over large flat white areas degenerates into a repeating
checkerboard, and 4K has four times the flat area. A/B: 4K at temperature 0 tiles; 4K at 0.7 is clean;
2K at 0 is clean. Temperature 0 was kept for repeatability, so 2K was kept. The output is blurred
(σ 20 at 4000²) and used only as a lighting map, so 2K loses nothing. **Re-run this A/B on any model change.**

## 6. Gemini shadows

"Patch" mode, asking Gemini to improve a shadow crop, erased the shadow in all three prompt variants.
"Harvest" mode, a full-scene Gemini render from which only the shadow under the real product is kept,
worked: consistent per-leg direction, grounded contacts. It remains in `src/shadow-patch.mjs` as a
candidate alternative shadow source; it is not in the pipeline.

## 7. Shadow presets

`long` casts a directional shadow behind-right, matching the front-left light. `short` is a soft
grounding shadow. A 2026-10-15 measurement of the July finals found the `long` shadow touching the
right frame edge on 14 of 22, and `short` keeping it inside on the SKU tested; that look decision has
not been taken.

## 8. Glass

The opaque composite paints dark rims on clear glass, because the matte's alpha is partial across the
whole body and Photoroom's colour decontamination there is dark. `transparent` takes see-through
regions from the shadow render. `render-only` uses the render alone, because even near-opaque rims
fried in `transparent`. Glass also uses `squarePlate`, since the luminance plate crops bright rims.
Per-group `group.json` arrived in the same work. Thirteen commits were squashed into `af781d7`; their
individual dates are not preserved.

## 9. HD matte and no-plate, opt-in

`pr-hd-background-removal: auto` (Photoroom Plus plan) gives crisper edges on sources of 2K and above.
`--no-plate` sends the raw source with `referenceBox=originalImage` instead of a detected, centred
plate.

## 10. Padding 0.10 → 0.0838

Iman calibrated `removeBackground` at padding 0, 0.05 and 0.10 and measured subject boxes of 3838,
3454 and 3071 px: a linear fit `3838 − 7675·padding`. That said 0.10 gave a 3071 px subject and a
~465 px margin, so the constant became 0.0838. Verified on 12 chairs at 401–407 px margin.

## 11. Tone controls

At strength 0.25, light fabric went from ≤ 0.02% of product pixels at ≥ 254 in the source to up to
13.4% in the final. Four changes: a highlight shoulder (roll-off above 236 instead of a hard clip),
`highlights` (on, off, auto by measured headroom), `shade` (scale the dark half), `exposure` (flat product
multiplier). Result on six light sofas: 0.00% at ≥ 254. The same commit fixed a cache bug: `strength`
was not in the final's key, so re-running at a new strength returned the old image.

## 12. Automatic tuning, not adopted

`scripts/auto_tune.mjs` solves strength, exposure and shade per SKU against three global targets.
It matched hand-picked values on light upholstery (0.51 and 0.47 against 0.55) but drove dark and
near-white goods to their limits. The commit concludes the targets must be relative to each product's
own tonality. Kept as a record.

## 13. Padding split by framing mode

Re-measured 2026-10-15 on plated 4000² originals and on a plated 2000² CDN chair: 0.10 gives a 3200 px
subject and 400 px margin; 0.0838 gives 3328–3330 px and 335–336 px, under spec. The 22 finals shipped in
July measure 3195–3202 px at 0.10. Iman's fit holds for `--no-plate`, where Photoroom fits the whole
source image: the CDN chairs fill ~96% of their frame, which is what the `3838 − 7675·padding` line
encodes; PE870153 re-measured 3194 px / 403 px at 0.0838. So Photoroom pads its reference box, and the
right value depends on framing mode. Now `PADDING = NO_PLATE ? 0.0838 : 0.10`. Between 2026-08-10 and
2026-10-15 the plated path ran at 0.0838.

**Consequence for production:** `--no-plate` framing depends on how much of its source the product
fills. 0.0838 is correct only for sources like the CDN chairs.

## 14. HD matte by default

On the 2026-10-15 category run, the standard matte left large partial-alpha regions on uniform flat
textiles: STOENSE rug 63% of body pixels partial, ALSTERN bath mat 97%. HD: 1.4% and 1.8%. No SKU got
worse; framing unchanged (3000 vs 3001 px). `--no-hd` opts out. The 22 reference finals were
regenerated with HD in `68712c4`.

## 15. Flatlay pose

Top-down items rendered `upright` get a standing-panel shadow reaching ~0.7 product widths to the right.
`short` does not fix it; Photoroom's `subjectPoseOverride: flatlay` gives the thin contact shadow they
should have. Pose became its own setting, applied to either preset, cached as `_flatlay`.

## 16. Open: shoulder without relight

The shoulder (#11) runs on every product pixel, even with relight off and `highlights: off`, so source
pixels above 236 are compressed (255 → 248). On a white armchair with no relight, the share of product
pixels at ≥ 250 falls from 20.1% to 0.24%. The code comment for `highlights: off` says the lit side
"stays exactly the source pixels", which is not what happens. Options: keep it as a deliberate tonal
policy, or apply it only where `fe > 1`. **Owners to decide.**
