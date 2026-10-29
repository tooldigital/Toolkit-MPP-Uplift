# MPP Uplift Pipeline

Takes a flat IKEA main product picture (one product on white) and produces a 4000×4000 image with a
gentle front-left relight, a neutral cast shadow and a 400 px margin, with no manual retouching. The
product's own pixels are kept; two AI services supply only a cut-out mask, a cast shadow and a blurred
lighting map.

**Status: prototype.** It won the proposal. It runs one SKU at a time on one machine, with local
caching and no tests. Production infrastructure is the next phase.

## Read in this order

| If you are | Read |
|---|---|
| Building the foundation for the whole pipeline (Artem) | `docs/foundation.md` |
| Designing the production system | `docs/handoff-backend.md`, then `docs/pipeline.md` |
| Re-implementing a stage | `docs/pipeline.md` (behaviour and maths), `docs/configuration.md` (every setting) |
| Asking "why is this constant this value?" | `docs/decisions.md` |
| Planning which products are ready | `docs/categories.md` |
| Looking at a script in `scripts/` | `docs/experiments.md` |
| Researching better, more consistent lighting | `docs/lighting-research-plan.md` |
| An AI coding agent | `CLAUDE.md` |

## Repository map

```
scripts/run_pipeline.mjs   the pipeline (one file, ~330 lines)
scripts/fetch_ikea.mjs     downloads test images listed in a selection file
scripts/exp_*, qc_*        experiments and QC utilities (docs/experiments.md)
src/                       plate, Photoroom and Gemini clients, debug logger
inputs/*.jpg               22 original source photos (committed)
inputs/group_*/            category test sets: manifest.json and optional group.json
outputs/finals*/           22 reference finals on white and grey (committed)
outputs/catalog_*          contact sheets and QC images from the category run (committed)
outputs/work/<sku>/        cached stages (local only)
docs/                      everything below
```

Category test images are not committed. Re-download them with:

```bash
node scripts/fetch_ikea.mjs fetch inputs/catalog_selection.json
```

`group_sofa` and `group_chair` list their image URLs in `manifest.json`, but the tool that fetched them
is not committed and they have no selection file. Two sofa entries have no URL: they are copies of
`inputs/PE979531.jpg` and `inputs/PE989302.jpg`.

## Setup

Node 20 or later.

```bash
npm install
```

```bash
cp .env.example .env
```

Put `PHOTOROOM_KEY` and `GEMINI_KEY` in `.env`. It is gitignored.

## First run

One SKU, about 35 seconds, 2 Photoroom calls and 1 Gemini call:

```bash
npm run pipeline -- --skus PE979531
```

Result: `outputs/finals/PE979531.jpg`. Intermediates: `outputs/work/PE979531/`. Running the same command
again makes no API calls; it reuses the cache.

The same SKU on grey, reusing every cached stage:

```bash
npm run pipeline -- --skus PE979531 --bg E8E8E8 --out outputs/finals_gray --sheet outputs/contact_sheet_gray.jpg
```

One category group, Photoroom only:

```bash
npm run pipeline -- --group group_legs --no-relight
```

Every flag and `group.json` key: `docs/configuration.md`.

## Checks

```bash
npm run check
```

Syntax-checks every script and module. For a behaviour check with no API calls, `scripts/check_composite.sh`
re-renders every composite path from cached stages and diffs the finals byte for byte against a recorded
baseline (`baseline` once, then `compare` after a change).

## When something looks wrong

- **A shadow points the wrong way** (Photoroom is non-deterministic): delete that SKU's
  `outputs/work/<sku>/shadow*`, `relit*` and `final*` files and run it again.
- **A change of settings had no effect:** relight on/off is not in the final's cache key, and mode is not
  in the shadow, matte or lightmap keys. Delete the SKU's `outputs/work/<sku>/` folder.
- **The run said "Done" but some SKUs failed:** the process exits 0 regardless. Read the summary line.
- **After a crash:** cache writes are not atomic. Delete the work folder of the SKU that was in progress.
- **The run stopped on a 429:** a Photoroom or Gemini rate limit. Run the same command again; it resumes.
- **To see every API request and every stage image:** add `--debug`.
