# Backend handoff — what the prototype is, what it proved, what it is not

Written 2026-10-15 for the backend / ML pipeline engineer who will design the production
infrastructure. The prototype got the proposal accepted; it was never built to run unattended.
This document is the honest state. Read it before `docs/pipeline.md` (the image-processing spec)
and `CLAUDE.md` (the invariants, each one learned by breaking it).

## 1. What it does, in one paragraph

Input: one IKEA product photo per SKU, product on clean white, any size (observed 804×4000 to
7402×4692; the public CDN tops out at 2000²). Output: a 4000×4000 JPEG, quality 95, with the
original product pixels untouched, a gentle front-left relight, a neutral cast shadow, and a 400 px
margin. Nothing is hand-retouched. The product pixels never come from a generative model; the two
AI services supply only a matte, a cast shadow, and a low-frequency lighting map.

## 2. The stage graph

Per SKU, strictly in this order; every stage is a file in `outputs/work/<sku>/` and is skipped if
that file exists.

| # | Stage | Code | External call | Output (cached) | Time | Deterministic |
|---|---|---|---|---|---|---|
| 1 | plate | `src/plate.mjs` | none | in memory (PNG, 4000²) | ~1–2 s | yes |
| 2 | shadow | `src/photoroom.mjs` | Photoroom `POST /v2/edit` (generateShadow) | `shadow<suffix>.jpg` ≈ 0.5–3 MB | ~5–10 s | **no** (shadow direction varies; multi-leg items occasionally wrong) |
| 3 | matte | `src/cutout.mjs` | Photoroom `POST /v2/edit` (removeBackground, HD header) | `matte_hd.png` ≈ 4–16 MB | ~5–10 s | mostly |
| 4 | relight | `src/gemini.mjs` | Gemini `gemini-3-pro-image-preview`, 2K, temp 0 | `relit<suffix>.jpg` ≈ 1–2 MB | ~10–15 s | **no** (temp 0 reduces but does not remove it) |
| 5 | composite | `scripts/run_pipeline.mjs` | none | `final<suffix>_<bg>.jpg` ≈ 0.3–4 MB | ~3 s, one JS loop over 16M px | yes |

Measured end-to-end on 2026-10-15: 33 s per SKU with relight, ~20 s without, sequential, with a
hard-coded 1.1 s sleep after each Photoroom call. Work cache per SKU ≈ 6 MB (standard matte) to 20 MB
(HD matte). 94 SKUs of cache = 1.2 GB.

API calls per SKU: 2 Photoroom + 1 Gemini. Render-only mode (glass): 1 Photoroom, 0 Gemini.
Re-composite with a different background, strength, highlight, or shade setting: 0 calls.

Stage 2 is the only one that matters for framing: Photoroom pads around the detected product
(`padding 0.10` → 3200 px subject, 400 px margin) and stages 3 and 5 inherit that frame. There is no
alignment step and must never be one (invariant 1).

## 3. External dependencies and their risks

**Photoroom** `https://image-api.photoroom.com/v2/edit`, multipart form, header `x-api-key`.
Two calls with different field sets; the shadow call pins `pr-ai-shadows-model-version: 2026-04-15`
and the matte call sends `pr-hd-background-removal: auto` (Plus plan). Sandbox keys are limited to
60/min and watermark output; the live key's limits and per-call price were not checked in this
prototype. A 429 stops the whole run; there is no retry or backoff. Non-determinism is real: the
accepted fix for a wrong-way leg shadow is delete-and-rerun, which means production needs a QC
gate and a bounded retry, not a one-shot call.

**Gemini** `gemini-3-pro-image-preview` via `@google/genai`. It is a preview model with no
stability guarantee. Output is consumed only as a blurred grayscale lighting map, so a model change
degrades gently rather than breaking the image, but the prompt/temperature/size triple (2K, temp 0)
was tuned by A/B and must be re-verified on any model change (invariant 3).

**IKEA CDN** (only for test data): `scripts/fetch_ikea.mjs` uses the public search endpoint and
`?imwidth=4000` image URLs. Newer assets (`pe1038xxx`+) ship on an off-white backdrop with a baked
floor shadow; the production input contract should say which it accepts.

## 4. Configuration model

Resolution per SKU: CLI flag > `inputs/<group>/group.json` > built-in default. Keys:
`mode` (opaque | transparent | render-only), `strength` (0.25), `shadow` (long | short),
`subjectPose` (upright | flatlay), `bg` (FFFFFF), `relight` (true), `highlights` (on | off | auto),
`exposure` (1), `shade` (1). All of these are composite-time except `mode`, `shadow`, `subjectPose`,
which change the Photoroom calls.

Gap: configuration is per **group folder**, not per SKU. A group that mixes top-down rugs and angled
boards cannot be rendered correctly in one pass. Production needs a per-SKU settings record, which
implies a classification step before rendering (section 7).

Gap: the cache key encodes shadow preset, pose, mode, HD, highlights, exposure, strength, shade and
background, but **not** relight on/off. Switching relight for a cached SKU silently reuses the old
final. Any production cache must key on the full parameter hash.

## 5. What the prototype is not

- **No tests, no CI, no lint.** `package.json` has one script. Verification was done by eye on
  contact sheets and by ad-hoc measurement scripts.
- **Sequential, single process.** One SKU at a time, one host, `.env` secrets, local disk cache.
- **Deliverables in git.** 56 tracked files under `outputs/` (53 MB), 215 MB pack. The 22 reference
  finals are useful as a regression baseline; the repo is not a storage system.
- **42 scripts, 2 of which are the product** (`run_pipeline.mjs`, `fetch_ikea.mjs`). The other 40
  are experiments, QC probes and one tuner (`auto_tune.mjs`, self-labelled not ready). They document
  dead ends and should be read as notes, not as code to port.
- **No per-SKU audit trail by default.** `--debug` writes a JSONL log of every request, response,
  cache hit and composite parameter (`src/debuglog.mjs`); it is the right shape for production
  telemetry and is off unless asked.
- **1,400 lines of pipeline code** (`src/` + the two product scripts). Small enough to re-implement
  in whatever the backend runs; the value is in the invariants and the measured parameters, not the
  JavaScript.

## 6. What is proven (measured, not assumed)

Full table and numbers: `docs/categories.md`. Summary across 88 SKUs in 14 categories plus the
original 22 and Iman's 24 sofas/chairs, all on white:

| Readiness | Categories | Note |
|---|---|---|
| Works with defaults | legs, small, textile, plant, glassware (render-only), off-white sources, dark, sofas, armchairs | 45/45 in the category set |
| Works with `highlights auto` | white, tall, reflective (chrome), dark-on-light-wood | default `on` clips chrome 8%, lit shades 11%, white fabric up to 12% |
| Works with `subjectPose flatlay` | flat (rugs, mats), fur that lies flat | wired 2026-10-15; `short` shadow does not substitute |
| Needs new work | hanging items (pendants, hanging plants): no "no cast shadow" option. Thin white tube frames: Photoroom returns no shadow. Mirrors and wire products on **non-white** backgrounds: matte alpha is partial across the mirror face (91–98%) and wire bodies (36–52%), hidden on white only. Plate detection on off-white sources (works today only because Photoroom re-detects). | |

Framing: padding 0.10 gives 3185–3202 px subject / 401–407 px margin across every category tested,
including 2000² CDN sources and extreme aspect ratios. Photoroom scatters ±3 px.

Non-white backgrounds were measured only on the original 22 (gray E8E8E8 set) and the 12 sofas
(F7F7F7). Anything with partial alpha has not been proven off-white.

## 7. Decisions the infrastructure design has to make

These are the questions, not the answers; the prototype took the simplest option for each.

1. **Classification before rendering.** Category determines mode, pose, highlights and shadow
   preset. Source: catalog metadata (IKEA `typeName` is reliable for the cases measured) or an
   image classifier. Without it, flat items get standing shadows and glass gets fried rims.
2. **Per-SKU, per-stage idempotent cache** keyed on (SKU, stage, full parameter hash, upstream
   output hash), in object storage, with the final composite as a pure function of three cached
   artifacts. Re-composites are free; API calls are the cost.
3. **API concurrency and rate policy.** Photoroom and Gemini limits for the live keys, backoff on
   429, bounded retries for the non-deterministic stages, and a per-SKU cost ledger
   (≈ 2 Photoroom + 1 Gemini per SKU; glass 1 + 0).
4. **QC gate.** Automatic checks that exist today as scripts: subject bbox / margin, shadow centroid
   direction, partial-alpha fraction, clipped-pixel fraction before/after relight. Thresholds are in
   `docs/categories.md`. Wrong-way shadows and blank shadows need either a retry loop or a human
   review queue; the prototype used a human.
5. **Model pinning.** Photoroom shadow model version is a header; Gemini is a preview model. Both
   need a re-verification playbook (the A/B in invariant 3) on change.
6. **Secrets and keys.** `.env` on a laptop today. The keys used in this prototype appeared in a chat
   transcript and should be rotated before production.
7. **Storage layout.** Inputs mirror into outputs by group; finals are 4000² JPEG q95 (0.3–4 MB).
   Decide whether intermediates are retained (they make re-composites free and audits possible) and
   for how long.
8. **Non-white backgrounds.** If the product spec includes them, mirrors, wire and sheer textiles need
   matte work before launch; if it is white-only, those categories are ready.

## 8. Where to read next

- `docs/pipeline.md` — the composite math and why there is no alignment step.
- `CLAUDE.md` — invariants 1–7 and every CLI flag with the measurement that justified it.
- `docs/categories.md` — the per-category results, with the scripts that measured them.
- `scripts/run_pipeline.mjs` — the one file that is the pipeline (≈500 lines with comments).
- `inputs/*/manifest.json` — every test image's source URL; all re-fetchable, none committed.
- `docs/plush_f7f7f7.md` — the fur-edge experiments, if fur on non-white is in scope.
