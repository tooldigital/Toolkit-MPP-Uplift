# MPP Uplift: platform handoff

The pipeline is a working prototype. It runs one photo at a time on a single machine, with a local
cache, and needs supervision. The next phase is a platform that runs reliably at catalogue volume and
supports ongoing experiments without copying code out of the pipeline. Architecture, language,
storage and hosting are open.

## What it does

Input: one IKEA product photo, one product on white. Output: one 4000×4000 JPEG with the product's
original pixels, a soft front-left relight, a neutral cast shadow and a 400 px margin. Each photo goes
through five stages:

1. **Plate** (local): cleans the white backdrop.
2. **Shadow** (Photoroom): returns the product with a cast shadow.
3. **Matte** (Photoroom): returns a cut-out mask.
4. **Relight** (Gemini): returns a relit image, which is blurred and used only as a lighting map. Its
   pixels never reach the final.
5. **Composite** (local): combines the stages. It makes no API calls, so a change of background,
   shadow strength or tone costs nothing once stages 1–4 are cached.

A full run takes about 33 s per photo: 2 Photoroom calls and 1 Gemini call.

## Running it

Node 20 or later. API keys are not in the repo, and the current keys must be rotated before use (see
Constraints).

```bash
npm install
cp .env.example .env        # add PHOTOROOM_KEY and GEMINI_KEY
npm run pipeline -- --skus PE979531
```

The final is written to `outputs/finals/PE979531.jpg` and its cached stages to
`outputs/work/PE979531/`. A second run makes no API calls. More examples are in the README.

## Fixed and open

**Fixed: the output.** The look depends on a set of rules and measured values. Product pixels are
never generated. The product's long side is held to 3200 px. The padding, shadow and relight settings
were each measured. `docs/decisions.md` explains each one. A change that alters the finals is a
product decision, not a refactor. `scripts/check_composite.sh` diffs every composite path byte for byte
against a recorded baseline, which shows whether a refactor changed the output.

**Open: everything else.** Code structure, storage, orchestration, concurrency and hosting are all
open, and so is which scripts to keep. Of the 45 scripts, only `run_pipeline.mjs` and `fetch_ikea.mjs`
are the product. The rest are experiment notes, indexed in `docs/experiments.md`.

## Known problems

Roughly in the order they will matter at volume:

- **No retries.** A rate limit (429) from either service stops the whole run. Failed photos still exit 0.
- **Stale cache hits.** The cache key leaves out the source file, some settings, and the model, prompt
  and code versions. Writes are not atomic (`docs/pipeline.md` §7).
- **Settings are per folder.** There is no way to store a setting for one product or one photo. IKEA's
  product type is saved with each download but not used. For production batches this is the largest
  gap. `docs/categories.md` lists which product categories need which settings.
- **"SKU" identifies the photo, not the product.** It is the PE number in the image filename, so one
  product with several photos counts as several products.
- **Photoroom is non-deterministic.** Occasionally a leg's shadow points the wrong way, or a thin white
  frame gets no shadow. Today these are caught by eye on contact sheets and fixed by re-running.
- **Single machine.** Processing is sequential, secrets live in `.env`, and there is no CI. The cached
  stages that the regression baseline depends on exist on one machine only.
- **Duplicated code.** Experiment scripts copy parts of `run_pipeline.mjs` instead of calling its
  stages, so they drift.
- **Images in git.** About 66 MB of outputs are tracked.

## Constraints

- **Gemini only through Freepik (now Magnific).** IKEA permits its data to go to Photoroom, and to
  Gemini only through Freepik's API. The code calls Google directly today. Freepik's Nano Banana Pro
  endpoint differs from the direct Google API in three ways:
  - it has no temperature setting, and the relight was tuned at temperature 0;
  - it takes images as URLs;
  - it runs jobs asynchronously.

  This should be tested first. Run the lighting panel (`inputs/lighting_panel.json`) through Freepik
  and compare against the cached Google results. If the relight does not hold up, the approach changes.
- **Private images.** Images sent by URL must come from private storage through short-lived signed URLs.
- **Key rotation.** The Photoroom and Gemini keys were exposed in a chat transcript on 2026-10-15.

## Open product decisions

These affect what gets built:

- how bright highlights are treated (`docs/decisions.md` #16);
- launch categories and backgrounds;
- delivery format;
- volume, turnaround and budget;
- how long files are kept;
- whether manual retouching is allowed.

## Reference

| For | Read |
|---|---|
| Prototype detail: costs, dependencies, limits | `docs/handoff-backend.md` |
| Behaviour and maths of each stage | `docs/pipeline.md` |
| Every flag and `group.json` key | `docs/configuration.md` |
| Rationale for each value | `docs/decisions.md` |
| Which product categories pass | `docs/categories.md` |
| Lighting research in progress | `docs/lighting-research-plan.md` |
