# Foundation brief

For Artem. The first job is a good foundation for the whole pipeline: the one system that research
experiments and IKEA batches both run on. You decide how to build it. This file gives the goals, the
facts and the known gaps. `docs/handoff-backend.md` describes the prototype; `docs/pipeline.md` is the
spec.

Written 2026-10-29 against `main` at `baf8ada`. Worked through with Codex.

## Goals

The foundation should make five things easy:

| # | Goal | What's missing today |
|---|---|---|
| 1 | **Group products and pick settings per product.** Research selections and batches use the same product records. Groups are folders; no grouping by product data, and no saved settings per product or photo (below). |
| 2 | **Run experiments through the pipeline itself.** Run one stage, swap a method, sweep a setting, re-composite from cached stages. | Orchestration and compositing live inside `scripts/run_pipeline.mjs`. Experiment scripts copy parts of it. |
| 3 | **Explain and reuse every result.** Each output records its source, resolved settings, code, model, prompt and Photoroom model versions, and keeps its stage outputs. | Cache keys miss inputs and versions; writes aren't atomic (`pipeline.md` §7). |
| 4 | **Compare results fairly.** Frozen-stage regression, the same metrics everywhere, contact sheets for review. | Reference finals are committed, but the cached stage files the regression needs are on one machine; the category-run metric scripts aren't in the repo; QC scripts use different conventions. |
| 5 | **Recover paid runs.** Retries, resume, honest failure reporting, cost per call. | 429 stops the run; exit code 0 even when SKUs fail; `--debug` logging is off by default. |

## Product grouping

**Today:**
- A group is a folder (`inputs/group_legs/`, `group_glass/`, …), created by `scripts/fetch_ikea.mjs` from the hand-picked `inputs/catalog_selection.json`.
- Settings apply to a whole top-level folder through `group.json` (`scripts/run_pipeline.mjs:123`). A single product can only be changed by a re-run with `--skus` and flags, which nothing saves. HD and framing are set for the whole run.
- Most folders' `manifest.json` records IKEA's product type (field `type`, from `typeName`; `scripts/fetch_ikea.mjs:32`), but nothing in the pipeline reads it. `group_glass` and `group_plush` have no manifest.
- `docs/categories.md` says which difficulty needs which setting, measured on 14 groups. Only the glassware (render-only) and fur (strength) settings are in a `group.json`; the pose and highlight findings aren't applied (`docs/configuration.md:76`).
- `scripts/auto_tune.mjs` tunes settings per SKU as an experiment; nothing keeps its results.

**A starting design (a suggestion; change it as you see fit):**

- **Product and photo are different things.** Today's "SKU" is the PE number in the image URL (`scripts/fetch_ikea.mjs:24`), which names a photo, not a product. Two images with the same filename share every cache entry (`docs/pipeline.md:23`). Settle identity before building records.

- **Product:** SKU, IKEA `typeName`, group, tags, overrides.
- **Photo:** image ID, product, source hash, properties (pose `upright` / `flatlay` / unknown), overrides. One product can have several photos.
- **Group:** a processing family pointing to a versioned settings profile (mode, pose, matte, shadow, relight, tone).
- **Tags** for difficulties that cut across groups: glass, fur, thin white frame, reflective, off-white backdrop, hanging. Tags don't multiply folders.

**How settings resolve:**
- Order: defaults → group profile → tag rules → product override → photo override → run override.
- Conflicting rules are reported, not silently resolved.
- Each run saves the resolved settings, so later edits don't change past results.

**Where assignments come from:**
- A hand-curated `typeName → group` table, seeded from `categories.md`.
- Photo properties set by a person for now; simple image measurements where they help.
- **The photo decides pose.** Product type can suggest a default, but a rug can be shot flat or angled.
- No ML classifier needed yet.

**Unknown types stay visibly unmapped.** A run either skips them or names a fallback profile explicitly.

Researchers add groups, mappings and profiles as ordinary data, with example SKUs and the reason.

## Constraints

- **Vendors:** IKEA data goes only to Photoroom and to Gemini **through Freepik's API** (now Magnific,
  `api.magnific.com`). `src/gemini.mjs` calls Google directly today.
- **Freepik's Gemini route differs** ([Nano Banana Pro reference](https://docs.magnific.com/api-reference/text-to-image/post-nano-banana-pro), read 2026-10-29):
  - no temperature setting, and the relight was tuned at temperature 0 (`decisions.md` #5);
  - images go in as URLs, not uploads;
  - jobs are asynchronous.
  - **First test:** run the lighting panel (`lighting-research-plan.md` §7, `inputs/lighting_panel.json`) through Freepik against the cached direct-Google results, with repeat runs. If the relight fails there, that's a conversation with IKEA or Freepik.
- **Image URLs** come from our own private storage: signed, short-lived, deleted once the job finishes,
  signatures kept out of logs.
- **Keys** appeared in a chat transcript on 2026-10-15 (`handoff-backend.md` §7.6). Rotate before any new runs.
- **Hosting** is your call.

## Housekeeping

- 66 MB of images in `outputs/` are tracked in git.
- Old repo `aklevecz/danish-traitors.v2`:
  - `code-only` (Iman) is fully in `main`;
  - `pipeline-groups-glass-plush` (Iman) has one commit not in `main` (`34ab516`), probably superseded by `af781d7`; Iman to confirm;
  - `edge-patch-and-harvest` (Ariel) was left out on purpose.

## Still open, for the owners

- **The look:** highlight policy (`decisions.md` #16), launch categories and backgrounds, delivery format.
- **Targets:** volume, turnaround, budget, retention, whether manual fixes are allowed.
