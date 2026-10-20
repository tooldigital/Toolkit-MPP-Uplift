# Backend handoff

For the engineer designing the production pipeline. The prototype got the proposal accepted; it was
never built to run unattended. This is the honest state of it, and the decisions it leaves open.

Verified against the code at commit `5236c2b` on 2026-10-15. Behaviour and maths: `docs/pipeline.md`.
Settings: `docs/configuration.md`. History of each constant: `docs/decisions.md`.

## 1. What it does

One product photo in; one 4000×4000 JPEG out, with the original product pixels, a gentle front-left
relight, a neutral cast shadow and a 400 px margin. Per SKU: a local plate step, two Photoroom calls
(cast shadow, cut-out mask), one Gemini call (used only as a blurred lighting map), and a local
composite. Stage graph and maths: `docs/pipeline.md` sections 2 and 3.

## 2. Measured cost and resources

| Item | Value | Source |
|---|---|---|
| Wall time per SKU, full | ~33 s, sequential | 2026-10-15, live keys |
| Wall time per SKU, no relight | ~20 s | 2026-10-15 category run |
| Calls per SKU | 2 Photoroom + 1 Gemini, in every mode while relight is on | `docs/pipeline.md` §2 |
| Calls per SKU, relight off | 2 Photoroom; glass `render-only`: 1 | same |
| Re-composite (new bg, strength, highlights, shade, exposure) | 0 calls, ~3 s | except new bg in `render-only` |
| Cache per SKU | ~6 MB (standard matte) to ~20 MB (HD matte, large product) | 94 SKUs = 1.2 GB |
| Final size | 0.3–4 MB JPEG | |
| Category run spend | 227 Photoroom + 28 Gemini calls for 88 SKUs plus re-tests | `docs/categories.md` |

**Unknown and needed:** live-key rate limits and per-call prices for Photoroom and Gemini; catalogue
volume; turnaround target; retention policy. The prototype sleeps 1.1 s after each Photoroom call and
never ran concurrently.

## 3. External dependencies

**Photoroom** `POST /v2/edit`. Two calls with different fields; exact requests in `docs/pipeline.md` §3.
- The shadow model is pinned by header (`pr-ai-shadows-model-version: 2026-04-15`).
- HD matting needs the Plus plan.
- **Non-deterministic.** On multi-leg furniture one leg's shadow occasionally points the wrong way. Thin
  white tube frames sometimes get no shadow at all. The only fix used so far is re-rendering.
- Iman raised the wrong-way shadow with Photoroom support; `scripts/exp_shadow_photoroom_advice.mjs`
  tests their two suggestions, with no recorded outcome.
- Any error mentioning 429, from either service, stops the prototype's whole run. No retry or backoff
  exists. Failed SKUs still leave an exit status of 0.

**Gemini** `gemini-3-pro-image-preview`, a preview model with no stability guarantee. Output is blurred
to a lighting map, so a model change should affect results less than if its pixels were used; that has
not been tested. The 2K / temperature-0 setting was chosen by A/B test against tiling artefacts and must
be re-tested on any change (`docs/decisions.md` #5).

**sharp / libvips** for decode, resize and encode. Inputs in any ICC profile are converted to sRGB on
decode; finals are written as sRGB without an embedded profile.

## 4. Configuration and cache, as they affect design

- Settings are **per input folder, not per SKU** (`docs/configuration.md`). Production needs a per-SKU
  settings record, which implies classifying each product before rendering.
- The prototype's cache key is the SKU name plus parameter suffixes. **It has five gaps** (`docs/pipeline.md`
  §7): no source hash; no relight on/off in the final; no mode in shadow, matte or relit; parameters
  rounded to hundredths; no model, prompt or code version. Writes are not atomic and existence counts as a
  hit. A production cache should key each stage on the hash of its inputs, every parameter that affects
  it, and the versions of the model, prompt and code that produced it, and write atomically.
- Shadow and relight are non-deterministic, so a final is reproducible only from its cached stages.
  Keeping intermediates is what makes re-composites free and audits possible.

## 5. What the prototype is not

- **No unit tests, no CI.** `npm run check` syntax-checks; `scripts/check_composite.sh` is a byte-for-byte
  regression of every composite path on cached stages (no API calls). Everything else was verified by eye
  on contact sheets and by ad-hoc measurement.
- **Sequential, single machine,** local disk cache, `.env` secrets.
- **Deliverables in git.** 128 tracked files under `outputs/`, ~66 MB. The 22 reference finals are a
  usable regression baseline; the repo is not a storage system.
- **45 scripts, of which 2 are the product.** The rest are experiments and QC utilities, indexed in
  `docs/experiments.md`. Read them as notes.
- **About 1,200 lines of code** in `src/` and the two product scripts, of which 240 are the experimental
  `src/shadow-patch.mjs`. The value is in the invariants and measured constants, not the JavaScript.
- **`--debug`** writes a JSONL log of every request, response, cache hit and composite parameter. It is
  the right shape for production telemetry and is off by default.

## 6. What has been shown

Full results: `docs/categories.md`. All on white backgrounds, small samples (4–8 SKUs per category).

| Finding | Categories |
|---|---|
| Passed on white with defaults | legs, small, textile, plant, glassware (render-only), off-white sources, dark, plus Iman's sofas and armchairs |
| Passed on white with `highlights: auto` | white, tall, reflective (chrome) |
| Passed with `subjectPose: flatlay` | top-down flat items, fur that lies flat |
| Not solved | hanging items (no way to turn the cast shadow off), thin white frames (no shadow returned), and anything with partial alpha on a **non-white** background (mirrors 91–98%, wire 36–52%) |

Framing held at 3185–3202 px subject, 399–407 px margin across every category and source size tested.

Non-white backgrounds were tested only on the 22 originals (E8E8E8) and Iman's sofas (F7F7F7).

## 7. Decisions for the production design

Open, and owned by the people building and approving it. The prototype took the simplest option for
each; that is not a recommendation.

1. **Classification before rendering.** Category decides mode, pose, highlights and shadow preset. Source
   options: catalogue metadata or an image classifier. IKEA's search API returns a product type name
   (`typeName`, recorded in every manifest); whether it maps cleanly to mode and pose has not been
   tested. It cannot tell a top-down rug shot from an angled board shot, which is a property of the
   photo, not the product.
2. **Stage cache and idempotency.** Per SKU and stage, keyed on input hashes and parameters, in object
   storage. The composite is a pure function of three cached artefacts.
3. **Concurrency, rate limits, retries.** Bounded retries for the non-deterministic stages, backoff on
   429, a per-SKU cost ledger.
4. **QC gate.** Metric definitions and observed ranges are in `docs/categories.md`: subject box and
   margin, partial-alpha share, cast-shadow area and offset, clipped share, tone percentiles. **The scripts
   that computed them for the category run were ad hoc and are not committed.** The committed QC scripts
   (`docs/experiments.md`) use other conventions, so a gate needs one new, tested implementation. Wrong-way and missing shadows need either an automatic retry against a check
   or a human review queue; the prototype used a human.
5. **Model pinning and change control.** Photoroom's shadow model is a header; Gemini is a preview model.
   Both need a re-test procedure.
6. **Secrets.** The prototype's API keys appeared in a chat transcript on 2026-10-15 and should be
   rotated before production.
7. **Storage and retention** for sources, intermediates and finals.
8. **Background scope.** If launch includes non-white backgrounds, mirrors, wire and sheer products need
   matte work first. If it is white only, those categories passed.

## 8. Questions for the owners

These change what gets built and are not engineering calls.

- **Bright-pixel fidelity.** The plate whitens product pixels above luminance 239, and the highlight
  shoulder compresses pixels above 236 even with relight off; a bright white source pixel ends at 248.
  Keep both as tonal policy, or preserve source highlights? (`docs/pipeline.md` §3.1, `docs/decisions.md` #16)
- **Delivery format.** Is sRGB without an embedded profile, 4:2:0 chroma, quality 95, 72 dpi the intended
  output?
- **Launch scope.** Which categories, modes and backgrounds, and what acceptance threshold per check?
- **Shadow look.** `long` runs off the right frame edge on large items; `short` stays inside.
- **Targets.** Throughput, turnaround, retention and spend.
- **Manual fixes.** One matte was clipped by hand in July (`docs/decisions.md` #4). Is a human-in-the-loop
  step allowed in production?
