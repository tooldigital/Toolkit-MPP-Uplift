# MPP Uplift Pipeline — agent notes

Node ≥ 20, ESM, sharp + Photoroom (`/v2/edit`) + Gemini (`gemini-3-pro-image-preview`). Turns flat IKEA
product photos (`inputs/**/<sku>.jpg`, on white) into 4000×4000 finals: original product pixels, gentle
front-left relight, neutral cast shadow, 400 px margin.

This file is for AI coding agents: working rules plus the invariants. Everything else lives in `docs/`:

| Need | File |
|---|---|
| Behaviour, maths, input/output contract | `docs/pipeline.md` |
| Every flag, `group.json` key, cache file name | `docs/configuration.md` |
| Why a constant has its value; what was tried | `docs/decisions.md` |
| Which product categories pass, with metrics | `docs/categories.md` |
| What each script in `scripts/` is | `docs/experiments.md` |
| Production design brief | `docs/handoff-backend.md` |

## Working rules

- `scripts/run_pipeline.mjs` is the pipeline. `scripts/fetch_ikea.mjs` fetches test images. Everything else
  in `scripts/` is an experiment or QC utility.
- Experiments write only to `outputs/experiments/`. Do not wire one into the pipeline unprompted.
- Read the comment on `IMAGE_SIZE` in `src/gemini.mjs` before touching the relight.
- Committed deliverables: `outputs/finals/`, `outputs/finals_gray/`, their contact sheets, and the
  `outputs/catalog_*` evidence. After changing finals, rebuild the contact sheets and commit both sets.
- Category test images (`inputs/group_*/*.jpg`) are gitignored; each group's `manifest.json` is not.
- Secrets live in `.env` (`PHOTOROOM_KEY`, `GEMINI_KEY`), never committed. Never send `.env` to an
  outside service.
- Photoroom and Gemini calls cost money. Prefer `--no-relight` and cached stages when testing, and say how
  many calls a run will make before starting a large one.
- When a doc and the code disagree, the code is the truth; fix the doc and note it.

## Invariants — each was learned by breaking it

1. **One shared frame.** Matte and shadow are made at 4000² with the same `PADDING` and `referenceBox`:
   `0.10` plated, `0.0838` with `--no-plate`. Photoroom pads around the product it detects, so both frame
   it identically (~7 px) and the composite is a straight per-pixel blend. **No** alignment, resampling,
   bbox-matching, dilation or feathering in the composite: each was tried and caused halos, ghosts,
   cropped shadows or gaps. Never `outputSize: originalImage` (full-bleed: loses margin, clips shadow).
   Padding history: `docs/decisions.md` #1, #10, #13.
2. **Product pixels come from the matte** in `opaque` mode. Never from the shadow render (soft) or Gemini
   (redrawn). Exceptions: `transparent` takes see-through regions from the render; `render-only` uses the
   render alone and the matte only as a mask. Two steps still alter product pixels: the plate whitens
   anything brighter than luminance 239, and the highlight shoulder compresses everything above 236 even
   with relight off (`docs/pipeline.md` §3.1, §3.5; `docs/decisions.md` #16, open).
3. **Gemini output is never pixels.** Lighting map only: 2K, temperature 0, upscaled to 4000, `blur(20)`.
   At temperature 0, 4K output tiles on flat white; 2K does not. If 4K is ever needed, raise temperature.
4. **Cast shadow comes from Photoroom `generateShadow`.** No procedural shadow (tried; looks fake).
   Photoroom is non-deterministic; a wrong-way leg shadow is fixed by deleting that SKU's `shadow*`,
   `relit*` and `final*` and re-running. Gemini shadow "patch" is a dead end; "harvest"
   (`src/shadow-patch.mjs`) is a candidate, not in the pipeline.
5. **Finals are 4000², native resolution.** Never downsample a deliverable.
6. **Cache identity.** Every parameter that changes a stage's output must be in its cache file name.
   Known gaps: no source hash; relight on/off missing from the final; mode missing from shadow, matte and
   relit; values rounded to hundredths; no model, prompt or code version. When changing a SKU's mode or
   relight, delete its `outputs/work/<sku>/` folder. List: `docs/pipeline.md` §7.
7. **Photoroom form fields are dotted** (`shadow.*`, `background.color`, `export.format`); let FormData set
   the Content-Type. Sandbox keys are limited to 60 calls/min.

## Common commands

```
npm run pipeline -- --skus PE1016720                       # one SKU
npm run pipeline -- --group group_legs --no-relight        # one group, Photoroom only
npm run pipeline -- --bg E8E8E8 --out outputs/finals_gray --sheet outputs/contact_sheet_gray.jpg
npm run pipeline -- --subject-pose flatlay --group group_flat --skus PE419173,PE700145
npm run pipeline -- --debug --skus PE1016720               # log every request and stage image
```

Full list: `docs/configuration.md`.
