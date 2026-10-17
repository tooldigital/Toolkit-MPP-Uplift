# Lighting research plan

**For:** the 3D research lead (Omniverse and Blender automation), with Ariel and Iman.
**Goal:** every product in a catalogue looks lit by the same studio: same key direction, same
key-to-fill ratio, same softness, run after run. Measured, not judged by eye. And one description of
that studio that drives our 2D pipeline, the Blender rig and the Omniverse rig alike.

**Constraint:** IKEA production will not use 3D scenes or 3D assets. Anything 3D here is a calibration
tool or an automatic by-product of the photo, never something an artist builds per SKU.

Written 2026-10-17. Pipeline facts: `docs/pipeline.md`. Measured results: `docs/categories.md`.

## 1. How lighting works today

Stage 4 of the pipeline, `src/gemini.mjs`:

1. Gemini (`gemini-3-pro-image-preview`, 2K, temperature 0) receives the Photoroom shadow render and a
   text prompt: "Soft front-left key light, slightly above the product. Mild ambient fill so the right
   side of the product is darker than the left but still readable."
2. Its output image is never used as pixels. It is resized to 4000², blurred (σ 20) and reduced to
   luminance: a soft lighting map `L`.
3. The product is multiplied by `f = 1 + ((L − mean(L)) / 128) · strength`, strength 0.25 by default.

What that means for consistency:

| Property | Today | Why it matters |
|---|---|---|
| Light direction | Whatever Gemini draws for that SKU | Not set numerically; only described in words |
| Repeatability | Varies between runs, even at temperature 0 | Two runs of one SKU can differ |
| Measured spread | Iman's 12-sofa set: key upper-left 12/12, swing 14.4% ± 2.6 edge to edge | About 18% relative spread in strength between SKUs |
| Shape awareness | Gemini infers the shape; the σ 20 blur then removes folds, legs and edges | The map is a broad gradient, not shading of the actual form |
| Existing studio light | The IKEA photo's own lighting stays; ours multiplies on top | Two lights stacked, never one coherent rig |
| Shadow | From Photoroom, direction set separately (`behindRight`) | Key and shadow agree by convention, not by construction |
| Model | A preview model with no stability guarantee | The look can drift without notice |

The house look the July prototype aimed at is `refs/correct_lighting_and_shadow.png`: soft key from front
left and above, gentle falloff to the right, low-contrast floor shadow behind right.

## 2. What already exists to build on

| Asset | Where | Use here |
|---|---|---|
| Lighting solved to photographic targets | Toolkit-Blender-Automation, `solve_lighting.py` | Wattages fitted by least squares to key level, key:fill ratio, background glow, corner falloff. This is already a numeric definition of "the studio". |
| Render measurement outside Blender | Toolkit-Blender-Automation, `eval.py` | Key:fill ratio, percentiles, clip share, floor and shadow readings |
| Product proxies in a cyclorama | Toolkit-Blender-Automation, `models/` | Bust, vase, dragon, car, glasses: test geometry with known shape |
| Light direction as numbers | Toolkit-Omniverse-Automation, relight skill step 3 | Key light as a normalised vector, each axis −1 to 1 (x left to right, y bottom to top, z back to front). Estimated by a Gemini text prompt. |
| Rig matched to a reference image | Toolkit-Omniverse-Automation, `/omniverse-relight-base` | Multi-pass key placement, HDRI dome, shadow matching |
| Lighting consistency measurement | this repo, `scripts/qc_sofa_consistency.mjs` | Plane fit of the applied relight: key direction and swing per SKU |
| Fidelity metrics | this repo, `docs/categories.md` Metrics | Clipped share, tone percentiles, partial alpha |
| 110 test photos | this repo, `inputs/` | The 22 originals plus 88 in 14 difficulty categories; category images re-fetch from their manifests |

## 3. The central idea: one light spec, three renderers

Write the studio down once, as data, and make every renderer obey it.

```json
{
  "key":  { "direction": [-0.7, 0.6, 0.4], "size": "large softbox", "softness": 0.6 },
  "fill": { "ratio_to_key": 0.35 },
  "rim":  { "ratio_to_key": 0.0 },
  "ambient": 0.25,
  "shadow": { "direction": "behindRight", "softness": 0.6, "intensity": 0.55 },
  "version": 1
}
```

Values above are placeholders. Phase 0 sets them.

The same spec then drives:

- **Blender:** key placement from `direction`, wattages solved to `ratio_to_key` with the existing solver.
- **Omniverse:** key placed at `direction` in the relight skill's own convention.
- **Our 2D pipeline:** whichever lighting-map method wins section 5, with the spec as input.

Then a gray sphere, a cube and the Blender proxies, rendered under the spec in Blender and in Omniverse,
become the **ground truth for what the 2D pipeline should produce.**

## 4. How a method plugs in

Any candidate must fit stage 4 without touching the rest of the pipeline:

```
lightmap(shadow_render, matte, light_spec) -> L   # 4000² grayscale, float
```

Rules, from the pipeline invariants (`docs/pipeline.md` §4):

- The method supplies light, never product pixels. A method that redraws the product is used only through
  its lighting map, the way Gemini is today.
- Deterministic is strongly preferred. A non-deterministic method must report its run-to-run spread.
- The composite stays as is. If a method needs a different composite (for example removing the photo's
  own shading first, method C), that is a proposal to the owners, not a silent change.
- The cast shadow stays Photoroom's unless the owners agree otherwise. Method E can produce a shadow; that
  would change invariant 4 and is a decision for the owners.

The backend engineer should make stage 4 pluggable (a `relight_method` setting) so methods can be
switched per category. That is a small change to one stage.

## 5. Candidate methods

| | Method | How it gets the light | Strength | Risk |
|---|---|---|---|---|
| A | **Gemini, tightened** (baseline) | Current prompt, plus: numeric direction in the prompt; the reference image as a second input (`scripts/exp_gemini_scene.mjs` exists); average of N runs | Already works on every category tested | Direction still a text instruction; preview model; cost per call |
| B | **Normals + analytic shading** | Estimate surface normals from the photo (MoGe-2, Marigold normals, newer object-specific models), then shade them under the spec: Lambert key plus fill plus ambient, optional ambient occlusion from estimated depth | Deterministic; direction exact by construction; a simplified version of what Blender computes, so directly comparable; cheap on one GPU | Normal quality on thin legs, wire, glass and fur; flat-lay items; no cast shadow |
| C | **Remove the photo's own lighting first** | Intrinsic decomposition (Adobe RGB↔X; Careaga and Aksoy's colourful diffuse decomposition) splits the photo into albedo and shading; replace the shading with B's or A's | Fixes the stacked-lights problem in section 1 | Changes product pixels: needs an owner decision against invariant 2; albedo errors on prints and patterns |
| D | **Diffusion relighters as lighting maps** | IC-Light; NVIDIA DiffusionRenderer, which relights from estimated surface buffers and an environment map | Can take an HDRI, the same one Omniverse uses | Redraws pixels, so lighting map only; heavy GPU; **licences unverified for commercial use** |
| E | **3D proxy from the photo** | Image-to-3D (for example TRELLIS, Hunyuan3D, Meta SAM 3D), proxy into Blender or Omniverse under the spec, render shading and shadow passes | Light and shadow from one rig; could solve hanging items and missing shadows (`docs/categories.md`) | Slowest; proxy quality varies by category; must stay fully automatic to meet the no-3D constraint |

Licence terms for C, D and E models must be checked from their official repositories before any
commercial use. Search results on 2026-10-17 found only second-hand claims (for example that IC-Light v1
and v2 carry different terms). That review needs whoever handles licensing, not an engineer's reading.

Suggested order: A and B first (cheap, and B is the most likely to give exact consistency), then C,
then D and E as exploration.

## 6. How to measure

### Synthetic ground truth from Blender

For each proxy (sphere, cube, bust, vase and a few furniture-like shapes), Blender renders:

1. **Input:** a flat, soft, IKEA-style studio render on white.
2. **Target:** the same object under the spec rig.
3. **Truth lighting map:** target luminance divided by input luminance over the product.

Run each method on (1) and compare its lighting map to (3). This gives a real error number, which
photos cannot.

### Real photos

A fixed **lighting panel** of about 24 SKUs from `inputs/`, spread across legs, upholstery, white, dark,
reflective, small, textile and tall. Every method runs on the whole panel.

| Metric | Definition | Target |
|---|---|---|
| Direction error | Angle between the fitted gradient of the applied relight and the spec's key direction projected to the image | Set in phase 0 |
| Direction spread | Standard deviation of that angle across the panel | Lower than Gemini's |
| Swing spread | Coefficient of variation of edge-to-edge relight strength across the panel | Below today's ~18% |
| Repeatability | Mean absolute difference between two runs' lighting maps | 0 for deterministic methods |
| Truth error | Mean absolute error against Blender's truth lighting map | Lowest wins |
| Fidelity | Clipped share and p01/p90 shift (`docs/categories.md` Metrics) | No worse than today |
| Cost | GPU seconds and API calls per SKU | Recorded, not ranked |

Plus a **blind side-by-side review**: the team picks between methods on the same SKU without knowing
which is which.

Direction and swing reuse the plane fit in `scripts/qc_sofa_consistency.mjs`, which works at 500² with
Rec. 709 luma. Use one measurement implementation for every method so numbers compare.

## 7. Phases

Sizes assume one person part-time; the owners set dates.

| Phase | Work | Deliverable | Decision at the end |
|---|---|---|---|
| 0. Spec | Measure `refs/correct_lighting_and_shadow.png`; express the Blender rig's solved targets as a spec; agree one coordinate convention for image, Blender and Omniverse | `light_spec.json` v1; the same gray sphere rendered in Blender and Omniverse, matching | Is this the house look? (owners) |
| 1. Harness | Synthetic pairs from Blender; one metrics script; lighting panel chosen | Baseline numbers for method A, today's prompt | — |
| 2. Cheap methods | A variants; B with two normal estimators | Panel and synthetic results; review sheet | Does B beat A on consistency without losing on look? |
| 3. Deeper methods | C, then D and E as exploration | Same results, plus cost per SKU | Which methods continue, per category |
| 4. Handoff | Chosen method(s) written up as a stage-4 spec for the backend engineer | Method spec, routing by category, test set | Adoption (owners) |

## 8. Questions to settle early

- **Is the reference image the house look,** or should the Blender rig define it?
- **Coordinate conventions.** Omniverse uses a normalised vector (axes as defined in the relight skill;
  its reference frame is not stated there); Blender places lamps in world space; the 2D pipeline works in
  image space. Pick one and convert the others.
- **Does relight replace or add to the photo's own light?** Today it adds. Replacing it (method C)
  changes product pixels.
- **Should key and shadow come from one rig?** Today they are set separately. One rig (method E, or B with
  a derived Photoroom direction) would make them agree by construction.
- **Per-category methods** are acceptable if they produce the same measured look.
- The bright-pixel issue in `docs/decisions.md` #16 affects any relight method; settle it first or measure
  around it.
