# Lighting research plan

**For:** the lighting researcher joining the project, with Ariel and Iman.
**Goal:** every product in a catalogue looks lit by the same studio: same key direction, same
key-to-fill ratio, same softness, run after run. Measured, not judged by eye. And one description of
that studio that any renderer can obey: our 2D pipeline, a Blender scene, an Omniverse scene.

**Constraint:** IKEA production will not use 3D scenes or 3D assets. Anything 3D in this plan is a
calibration tool or an automatic by-product of the photo, never something an artist builds per SKU.

Written 2026-10-17, revised 2026-10-19 with measurements. Pipeline facts: `docs/pipeline.md`. Measured results:
`docs/categories.md`.

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
| Repeatability | Varies between runs, even at temperature 0 (measured in §2) | Two runs of one SKU can differ |
| Spread between SKUs | Measured in §2 | Products in one catalogue page look lit differently |
| Shape awareness | Gemini infers the shape; the σ 20 blur then removes folds, legs and edges | The map is a broad gradient, not shading of the actual form |
| Albedo in the map | The map is the relit image's luminance, so the product's own light and dark areas are in it (measured in §2) | Pale parts get brighter and dark parts darker regardless of where the light is |
| Existing studio light | The IKEA photo's own lighting stays; ours multiplies on top | Two lights stacked, never one coherent rig |
| Shadow | From Photoroom, direction set separately (`behindRight`) | Key and shadow agree by convention, not by construction |
| Model | A preview model with no stability guarantee | The look can drift without notice |

The house look the July prototype aimed at is `refs/correct_lighting_and_shadow.png`: soft key from front
left and above, gentle falloff to the right, low-contrast floor shadow behind right.

## 2. Measured starting point

Measured 2026-10-19 from cached stages on Ariel's machine, with `scripts/qc_relight_direction.mjs` and
`scripts/exp_relight_repeat.mjs` (both committed; the first makes no API calls). Angle convention:
bright side of the product, 0° = right, 90° = up, 180° = left, so the intended front-left key is in
the 90° to 180° quadrant.

**The lighting map carries the product's own colours.** The pipeline's map is the luminance of
Gemini's relit image. Mean-normalisation removes the overall level, but a pale leg under a dark seat
still reads as "light from below": VEDBO (PE638683) measures a bright side at −90°, straight down, and
its relight brightens the legs further (the 2.2% clip in `docs/categories.md`). Dividing the map by the
input's own luminance (relit ÷ shadow render) cancels this and leaves only the change Gemini made.

| Measurement | Result | n |
|---|---|---|
| Key direction, as applied (absolute map) | circular mean 142°, circular sd **49°**; upper-left quadrant 38/50 | 50 SKUs |
| Key direction, albedo cancelled (ratio map) | circular mean 155°, circular sd **26°**; upper-left 41/50 | 50 |
| Applied relight swing at strength 0.25 (absolute) | mean 13.8%, sd 7.5%, **CV 54%** | 50 |
| Same, Iman's single-category sofa set | 14.4% ± 2.6, CV 18% (`docs/categories.md`) | 12 |
| Repeatability, same input, same prompt, temperature 0 | 3 of 4 maps agree (factor MAD ≤ 0.6%, angle within 1°); **1 of 4 diverged** (angle 25° off, MAD 1.6%, max 6.5%) | 1 SKU, 4 maps |
| Reference image, upper body left third : right third | 1.14 : 1 | — |
| Reference image, floor shadow | darkest background pixel 245 of 255, lower left: shadow nearly absent | — |

Reading: within one category the look is fairly consistent (CV 18%). Across categories it is not
(CV 54%, direction sd 49°). Roughly half the direction spread is the products' own tonal layout, which
the absolute map passes into the relight; the rest, sd 26°, is Gemini. Gemini is usually repeatable at
temperature 0 but not always. The 50 SKUs are those with cached relights: the 22 originals, two to four
per category from the 2026-10-15 run, and the dark group.

The reference image's own key is soft (1.14 : 1) and its shadow is far fainter than the Photoroom `long`
preset produces. Whichever is the house look, the spec must say so.

## 3. What already exists to build on

| Asset | Where | Use here |
|---|---|---|
| Lighting consistency measurement | this repo, `scripts/qc_sofa_consistency.mjs` | Plane fit of the applied relight: key direction and swing per SKU |
| Fidelity metrics | this repo, `docs/categories.md` Metrics | Clipped share, tone percentiles, partial alpha |
| 110 test photos | this repo, `inputs/` | The 22 originals plus 88 in 14 difficulty categories; category images re-fetch from their manifests |
| Cached stages for ~95 SKUs | Ariel's machine, `outputs/work/` | Shadow renders, HD mattes and Gemini lightmaps: inputs for any new method without new API calls |
| Reference-image Gemini path | this repo, `scripts/exp_gemini_scene.mjs` | Passes a reference image as a second input; a starting point for method A |
| Gemini shadow harvest | this repo, `src/shadow-patch.mjs` | Full-scene Gemini render, shadow kept; relevant if light and shadow are ever to come from one source |
| The researcher's own 3D environment work | theirs | The calibration scene in §4 should be built in whatever they already drive well |

The organisation has earlier Blender and Omniverse automation. It is not a dependency of this plan; the
researcher may consult it or not.

## 4. The central idea: one light spec, every renderer obeys it

Write the studio down once, as data.

```json
{
  "version": 1,
  "frame": "camera: x right, y up, z toward the camera; unit vectors point from the product to the light",
  "key":   { "direction": [-0.60, 0.55, 0.58], "softness": 0.6 },
  "fill":  { "direction": [0.70, 0.20, 0.68], "ratio_to_key": 0.35 },
  "ambient": 0.25,
  "shadow": { "direction": "behindRight", "softness": 0.6, "intensity": 0.55 }
}
```

Values above are placeholders; phase 0 sets them from §2. The coordinate frame is fixed here on purpose:
camera-relative, so it means the same thing for a photo, a Blender camera and an Omniverse camera.
Blender and Omniverse place their lights in world space; a ten-line script converts from this frame
given the camera transform.

**One calibration scene, authored by us.** A gray 18%-reflectance sphere, a cube, a cylinder, and three
or four product-like shapes (a chair with thin legs, a box cabinet, a flat rug, a vase), on a white
cyclorama, under a key, a fill and an ambient dome driven by the spec. Author it once as USD: Blender
exports USD and Omniverse reads it natively, so the same geometry and the same rig render in both.
Renderer differences (Cycles against RTX path tracing) then show up as a measured gap between two
images of the same scene, which is itself useful to know.

The spec then drives three things:

- **Blender:** lamp placement and power from the spec.
- **Omniverse:** the same, through the USD rig.
- **Our 2D pipeline:** whichever lighting-map method wins §6, with the spec as input.

And the calibration renders become the **ground truth for what the 2D pipeline should produce** (§7).

## 5. How a method plugs in

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

## 6. Candidate methods

| | Method | How it gets the light | Strength | Risk |
|---|---|---|---|---|
| A0 | **Ratio map** (zero-cost change) | Same Gemini call; use relit ÷ shadow render instead of relit alone as the map, so only the change Gemini made is applied | Cancels the product's own albedo; halves the measured direction spread (§2); no new calls | The `relit − base` variant was tried for glass and "fried at strength"; untested on opaque at 0.25; still Gemini's direction |
| A | **Gemini, tightened** (baseline) | Current prompt, plus: numeric direction in the prompt; the reference image as a second input (`scripts/exp_gemini_scene.mjs` exists); average of N runs | Already works on every category tested | Direction still a text instruction; preview model; cost per call |
| B | **Normals + analytic shading** | Estimate surface normals from the photo (MoGe-2, Marigold normals, newer object-specific models), then shade them under the spec: Lambert key plus fill plus ambient, optional ambient occlusion from estimated depth | Deterministic; direction exact by construction; a simplified version of what a path tracer computes, so directly comparable to the calibration renders; cheap on one GPU | Normal quality on thin legs, wire, glass and fur; flat-lay items; no cast shadow |
| C | **Remove the photo's own lighting first** | Intrinsic decomposition (Adobe RGB↔X; Careaga and Aksoy's colourful diffuse decomposition) splits the photo into albedo and shading; replace the shading with B's or A's | Fixes the stacked-lights problem in §1 | Changes product pixels: needs an owner decision against invariant 2; albedo errors on prints and patterns |
| D | **Diffusion relighters as lighting maps** | IC-Light; NVIDIA DiffusionRenderer, which relights from estimated surface buffers and an environment map | Can take an HDRI, so the spec can be expressed as an environment map shared with the 3D renderers | Redraws pixels, so lighting map only; heavy GPU; **licences unverified for commercial use** |
| E | **3D proxy from the photo** | Image-to-3D (for example TRELLIS, Hunyuan3D, Meta SAM 3D), proxy placed in the calibration scene under the spec, render shading and shadow passes | Light and shadow from one rig; could solve hanging items and missing shadows (`docs/categories.md`) | Slowest; proxy quality varies by category; must stay fully automatic to meet the no-3D constraint |

Licence terms for C, D and E models must be checked from their official repositories before any
commercial use. Search results on 2026-10-17 found only second-hand claims (for example that IC-Light v1
and v2 carry different terms). That review needs whoever handles licensing, not an engineer's reading.

Suggested order: A0 and A first (cheap), B next (the most likely to give exact consistency), then C,
then D and E as exploration.

## 7. How to measure

### Synthetic ground truth from the calibration scene

For each shape in the calibration scene, render:

1. **Input:** a flat, soft, IKEA-style studio render on white (even dome light, no key).
2. **Target:** the same shape under the spec rig.
3. **Truth lighting map:** target luminance divided by input luminance, over the product.

Run each method on (1) and compare its lighting map to (3). This gives a real error number, which
photos cannot. Render (1) and (2) in both Blender and Omniverse; the difference between the two truth
maps is the renderer gap, and a method within that gap of either is as good as the renderers agree.

### Real photos

A fixed **lighting panel** of about 24 SKUs from `inputs/`, spread across legs, upholstery, white, dark,
reflective, small, textile and tall. Every method runs on the whole panel.

| Metric | Definition | Target |
|---|---|---|
| Direction error | Angle between the fitted gradient of the applied relight and the spec's key direction projected to the image | Set in phase 0 |
| Direction spread | Standard deviation of that angle across the panel | Lower than Gemini's (§2) |
| Swing spread | Coefficient of variation of edge-to-edge relight strength across the panel | Lower than Gemini's (§2) |
| Repeatability | Mean absolute difference between two runs' relight factors over the product | 0 for deterministic methods; Gemini's in §2 |
| Truth error | Mean absolute error against the calibration truth map | Lowest wins |
| Fidelity | Clipped share and p01/p90 shift (`docs/categories.md` Metrics) | No worse than today |
| Cost | GPU seconds and API calls per SKU | Recorded, not ranked |

Plus a **blind side-by-side review**: the team picks between methods on the same SKU without knowing
which is which.

Direction and swing come from `scripts/qc_relight_direction.mjs`, which fits a plane over product pixels
on both the absolute and the ratio map, with circular statistics. Measure direction on the **ratio**
map, so a method is not blamed for the product's colours. Use that one implementation for every method
so numbers compare. (`scripts/qc_sofa_consistency.mjs` is an earlier fit at 500² with Rec. 709 luma;
its numbers are not comparable.)

## 8. Phases

Sizes assume one person part-time; the owners set dates.

| Phase | Work | Deliverable | Decision at the end |
|---|---|---|---|
| 0. Spec | Turn §2's measurements of the reference image and the shipped finals into `light_spec.json` v1; author the calibration scene; render the gray sphere in Blender and Omniverse | Spec v1; two sphere renders that match within a stated tolerance | Is this the house look? (owners) |
| 1. Harness | Synthetic pairs from the calibration scene; extend `qc_relight_direction.mjs` with truth error and fidelity; lighting panel chosen | Baseline numbers for method A, today's prompt, on the panel and the synthetic set | — |
| 2. Cheap methods | A variants; B with two normal estimators | Panel and synthetic results; review sheet | Does B beat A on consistency without losing on look? |
| 3. Deeper methods | C, then D and E as exploration | Same results, plus cost per SKU | Which methods continue, per category |
| 4. Handoff | Chosen method(s) written up as a stage-4 spec for the backend engineer | Method spec, routing by category, test set | Adoption (owners) |

## 9. Questions to settle early

- **What is the house look:** the reference image (soft 1.14 : 1 key, almost no floor shadow) or the 22
  shipped finals (stronger relight, `long` Photoroom shadow)? They differ, and §2 measures both.
- **Does relight replace or add to the photo's own light?** Today it adds. Replacing it (method C)
  changes product pixels.
- **Should key and shadow come from one rig?** Today they are set separately. One rig (method E, or B with
  a derived Photoroom direction) would make them agree by construction.
- **Per-category methods** are acceptable if they produce the same measured look.
- The bright-pixel issue in `docs/decisions.md` #16 affects any relight method; settle it first or measure
  around it.
