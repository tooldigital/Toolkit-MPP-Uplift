# Scripts other than the pipeline

`scripts/` holds 44 files. Two are the product: `run_pipeline.mjs` (the pipeline) and `fetch_ikea.mjs`
(test-image fetcher). The other 42 are listed here. They are notes, not code to port: each answers one
question, and most write only to `outputs/experiments/`.

Status values: **adopted** (became a pipeline feature), **in use** (builds a deliverable or measures
one), **dead end** (recorded as not working), **record** (kept for history; outcome stated where the
repo states it, otherwise "outcome not recorded"). Author: Ariel (A), Iman (I).

## QC and build utilities

These read cached stages and make no API calls unless noted. They are the starting point for an
automated QC gate.

| Script | Author | Status | What it does |
|---|---|---|---|
| `qc_chair_shadow_zoom.mjs` | I | in use | Crops the same ground band on every SKU of a group so a wrong-way leg shadow is visible side by side. `--boost` adds a contrast-stretched copy. |
| `qc_sofa_consistency.mjs` | I | in use | Per group: key-light direction (plane fit of the applied relight), shadow side and reach, relight swing. Prints spread stats and a 3-row sheet. |
| `qc_sofa_texture.mjs` | I | in use | Checks the relight did not alter product texture (invariant 2). |
| `qc_plush_f7f7f7.mjs` | I | in use | Plush deliverables: present, 4000², cast shadow grounded, fringe not blown out. Non-zero exit on failure. |
| `build_plush_f7f7f7.sh` | I | in use | Builds the plush F7F7F7 deliverables in several versions per SKU. Process in `docs/plush_f7f7f7.md`. |
| `auto_tune.mjs` | I | record | Solves strength, exposure and shade per SKU against global targets. Not adopted; see `docs/decisions.md` #12. |
| `qc_relight_direction.mjs` | A | in use | Per SKU: fitted key direction and swing of the applied relight, on the absolute map and on the albedo-cancelled ratio map, with circular statistics. Seed of the lighting harness (`docs/lighting-research-plan.md`). |

## Framing, matte and Photoroom shadow

| Script | Author | Status | What it showed |
|---|---|---|---|
| `exp_hd_removal.mjs` | I | adopted | HD background removal. Opt-in 2026-08-10, default 2026-10-15. |
| `exp_referencebox.mjs` | I | adopted | `referenceBox=originalImage` framing, skipping the plate. Became `--no-plate`. |
| `exp_shadow_photoroom_advice.mjs` | I | record | Tests Photoroom support's two suggestions for the wrong-way leg shadow (numeric direction sweep, subject pose variants). Outcome not recorded. |
| `exp_shadow_paramsweep.mjs` | I | record | Separates shadow length from offset; tied to the white-line rim. Outcome not recorded. |
| `exp_shadowfix_whiteline.mjs` | I | record | Diagnoses a white line around dark feet: the shadow factor's product mask cancels the contact shadow where alpha is fractional. Variants tested; the pipeline formula is unchanged. |
| `exp_plush_shortlong.mjs` | I | record | No-plate + HD, F7F7F7, `short` against `long` on four plush toys. Outcome not recorded. |

## Glass

| Script | Author | Status | What it showed |
|---|---|---|---|
| `exp_subj_over_base.mjs` | I | record | Glass as a straight cutout over the Photoroom render, with relight. Superseded by `render-only` (decision #8). |
| `exp_shadow_plus_object.mjs` | I | record | Two layers only: render as background, crisp cutout on top. Superseded by `render-only`. |

## Gemini shadows

| Script | Author | Status | What it showed |
|---|---|---|---|
| `exp_shadow_patch.mjs` | A | dead end | Asking Gemini to improve a shadow crop erases the shadow (three prompt variants). |
| `exp_shadow_harvest.mjs` | A | record | Full-scene Gemini render, keep only the shadow under the real product. Works; a candidate alternative shadow source. Uses `src/shadow-patch.mjs`. |
| `exp_relight_repeat.mjs` | A | record | Runs the relight N times on one cached input and compares the maps: 3 of 4 agreed, 1 diverged 25° (2026-10-19). Costs N Gemini calls. |
| `exp_gemini_scene.mjs` | A | record | One-shot lighting plus shadow from Gemini with a reference image. Outcome not recorded; the pipeline uses Gemini only as a lighting map. |
| `exp_otter_shadow.mjs` | I | record | Controlling the direction of a Gemini shadow for a flat product that Photoroom leaves shadowless. |

## Fur edges and white fringe (plush)

All Iman's. The two that build the plush deliverables are marked in use; the rest are steps toward
them. The chosen process and why: `docs/plush_f7f7f7.md`. Several of these put Gemini-generated pixels
at the product edge, which the main pipeline never does (invariant 2).

| Script | Status | Question |
|---|---|---|
| `exp_fur_edge_finalize_shadow.mjs` | in use | "Band" finals: real interior, Gemini-cleaned fur rim, over the Photoroom shadow. |
| `exp_dehalo.mjs` | in use | "Dehalo" border swap for items with no Photoroom shadow (the otter). |
| `exp_fur_edge.mjs` | record | Does asking Gemini to add fur texture at the edge help? |
| `exp_fur_edge_relight.mjs` | record | Relight applied at the end of the fur-edge composites. |
| `exp_fur_edge_inv.mjs` | record | Inverse-mask composite: real product inside, Gemini output around it. |
| `exp_fur_edge_inv_relight.mjs` | record | Same, relit at the end. |
| `exp_fur_edge_band.mjs` | record | A much wider Gemini band reaching inward from the silhouette. |
| `exp_fur_edge_greytest.mjs` | record | Does a grey background recover white fur that vanishes on white? |
| `exp_fur_edge_finalize.mjs` | record | Grey plush finals with band composite and background lock. |
| `exp_fur_edge_finalize_white.mjs` | record | White plush finals from the band experiment. |
| `exp_fur_edge_finalize_inv.mjs` | record | Shadowless-product finals via the inverse composite. |
| `exp_fur_edge_f7_gemshadow.mjs` | record | F7F7F7 plush with the Gemini shadow, split at a flood-filled silhouette. |
| `exp_plush_f7_gemshadow_simple.mjs` | record | F7F7F7 plush with the Gemini shadow using the standard composite, because fancier masks kept making halos. |
| `exp_dehalo_shadow.mjs` | record | One Gemini call that cleans the fur edge and draws a grounding shadow. |
| `exp_dehalo_furshadow.mjs` | record | Fur from one Gemini output, shadow from another. |
| `exp_hybrid_prshadow.mjs` | record | Gemini fur only in a thin silhouette band; Photoroom shadow verbatim. |
| `exp_hybrid_grow.mjs` | record | Same, but Gemini may extend wisps outward past the matte. |
| `exp_edgeclean.mjs` | record | Clean the fringe on the cutout before shadow and lighting. |
| `exp_cutout_clean.mjs` | record | Clean both RGB and alpha of the cutout edge; earlier attempts cleaned RGB only and the rim returned. |
| `exp_cutout_darkgray.mjs` | record | Same, cleaning against dark grey so the fringe has contrast. |
| `exp_cutout_bg.mjs` | record | How dark the background must be for Gemini to see the fringe. |
| `exp_cutout_alpha.mjs` | record | Passing the cutout to Gemini with its alpha instead of flattened. |
