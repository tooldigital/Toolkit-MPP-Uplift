# MPP Uplift: handoff to Artem

Artem, this pipeline is yours now. Iman and I built it as research. It shows the look works, and it
won the proposal. But it is a prototype: it runs one photo at a time on one laptop, and someone has to
watch it. Your job is to turn it into a platform: something that runs reliably at IKEA volumes, and
that Iman and I can keep experimenting on without copying code out of it. How you build it, in what
language, and where it runs are your calls.

## What it does

One IKEA product photo goes in (one product on white). One 4000×4000 JPEG comes out. The product's
own pixels are kept, with a soft front-left relight, a neutral cast shadow and a 400 px margin. Each
photo goes through five stages:

1. **Plate** (local): cleans the white backdrop.
2. **Shadow** (Photoroom): returns the product with a cast shadow.
3. **Matte** (Photoroom): returns a cut-out mask.
4. **Relight** (Gemini): returns a relit image. We blur it and use it only as a lighting map. Its
   pixels never reach the final.
5. **Composite** (local): puts the pieces together. It needs no API calls, so changing the
   background, shadow strength or tone is free once stages 1–4 are cached.

A full run takes about 33 s per photo and costs 2 Photoroom calls and 1 Gemini call.

## Run it first

Node 20 or later. Ask me for API keys: the old ones must be rotated first (see below).

```bash
npm install
cp .env.example .env        # add PHOTOROOM_KEY and GEMINI_KEY
npm run pipeline -- --skus PE979531
```

The final lands in `outputs/finals/PE979531.jpg` and its cached stages in `outputs/work/PE979531/`.
Run the command again and it makes no API calls. The README has more examples.

## What to keep, and what you can change

**Keep the output.** The look rests on a set of rules and measured values: product pixels are never
generated, the product's long side is held to 3200 px, and the padding, shadow and relight settings
were each measured. Each one is explained in
`docs/decisions.md`. If a change would alter the finals, check it with Iman or me first.
`scripts/check_composite.sh` diffs every composite path byte for byte against a recorded baseline, so
you can refactor and prove nothing moved.

**Everything else is open:** code structure, storage, orchestration, concurrency, hosting, and which of
the 45 scripts survive. Only `run_pipeline.mjs` and `fetch_ikea.mjs` are the product. The rest are
experiment notes, indexed in `docs/experiments.md`.

## What hurts today

These are the known problems, roughly in the order they will bite at volume:

- **No retries.** A rate limit (429) from either service stops the whole run. Failed photos still
  exit 0.
- **The cache can serve stale results.** The cache key misses the source file, some settings, and the
  model, prompt and code versions, and writes aren't atomic (`docs/pipeline.md` §7).
- **Settings are per folder.** You can't say "this product needs flat-lay pose" or "this photo needs
  highlights on" and have it stick. IKEA's product type is saved with each download, but nothing uses
  it. For real batches this is the biggest missing piece. `docs/categories.md` says which kind of
  product needs which settings.
- **"SKU" means the photo, not the product.** It's the PE number in the image filename, so one product
  with several photos looks like several products.
- **Photoroom is non-deterministic.** Now and then a leg's shadow points the wrong way, or a thin white
  frame gets no shadow at all. Today a person spots these on a contact sheet and re-runs the photo.
- **Sequential, single machine,** local disk cache, secrets in `.env`, no CI. The cached stages the
  regression baseline needs exist on one machine only.
- **Experiments copy code.** Research scripts copy parts of `run_pipeline.mjs` instead of running
  stages through it, so they drift.
- **Images in git.** About 66 MB of outputs are tracked.

## Hard constraints

- **Gemini only through Freepik (now Magnific).** IKEA allows its data to go to Photoroom, and to
  Gemini only through Freepik's API. The code calls Google directly today. Freepik's Nano Banana Pro
  route has no temperature setting (we tuned the relight at temperature 0), takes images as URLs, and
  runs jobs asynchronously. **Test this first:** run the lighting panel (`inputs/lighting_panel.json`)
  through Freepik and compare against the cached Google results. If the relight doesn't hold up, the
  plan changes, and that becomes a conversation with IKEA.
- **Images by URL must stay private.** Serve them from your own storage with short-lived signed URLs.
- **Rotate the keys.** The Photoroom and Gemini keys appeared in a chat transcript on 2026-10-15.

## Not engineering calls

These belong to IKEA and us, and some of them change what you build: how bright highlights are treated
(`docs/decisions.md` #16), which categories and backgrounds launch, the delivery format, volume,
turnaround, budget, how long files are kept, and whether a person may fix images by hand. Ask before
you build around an assumption.

## Where to look

| For | Read |
|---|---|
| The prototype in depth: costs, dependencies, limits | `docs/handoff-backend.md` |
| Exact behaviour and maths of each stage | `docs/pipeline.md` |
| Every flag and `group.json` key | `docs/configuration.md` |
| Why a value is what it is | `docs/decisions.md` |
| Which product categories pass | `docs/categories.md` |
| The lighting research in progress | `docs/lighting-research-plan.md` |

Ask Iman or me about the look, the research, or why anything is the way it is.

You don't need the old repo, `aklevecz/danish-traitors.v2`. Iman's `code-only` work is all in `main`.
One leftover commit on another branch is probably superseded, and Iman is confirming.
