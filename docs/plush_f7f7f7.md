> **Status: experimental workflow, separate from the pipeline.** Written by Iman, August 2026; content
> unchanged since. The FUR EDGES and NO FUR versions put **Gemini-generated pixels at the product edge**
> (and, for the otter, a Gemini cast shadow), which the main pipeline never does (`docs/pipeline.md`
> invariants 2 to 4). Results depend on cached Gemini outputs that are not committed; a fresh run may
> differ. Neither the plush source images nor these deliverables are in the repository. Scripts are
> indexed in `docs/experiments.md`.
>
> Known drift: `scripts/build_plush_f7f7f7.sh` now builds **four** versions per SKU (adds `normalhd`,
> HD matte), not three, and its cache handling predates the current cache file names
> (`docs/configuration.md`). A fresh rebuild has not been verified since.

# Plush finals on F7F7F7 — three versions (normal / fur edges / no fur)

Finalized process for the `group_plush` SKUs on a light-grey **F7F7F7** background. Every plush is
delivered in **three versions** in one folder, all carrying a gentle **0.08 product-only relight**:

- **NORMAL** — the standard pipeline (opaque composite + Photoroom shadow + relight). The **baseline**:
  no fur-edge de-halo, so it keeps the white matting rim, and the flat otter has **no shadow** at all
  (Photoroom can't ground it). This is what the other two versions fix.
- **FUR EDGES** — a soft feathered fur edge (fine strands drawn at the silhouette), rim removed.
- **NO FUR** — the same clean silhouette with the white matting rim removed, but **no** drawn strands.

Deliverables — one folder, three files per SKU:

- `outputs/finals_plush_f7f7f7_all/group_plush/<sku>_{normal,furedge,nofur}.jpg`
- `outputs/compare_plush_normal_fur_nofur.jpg` — QC sheet, NORMAL | FUR EDGES | NO FUR, one row per SKU.

## Build it

```
./scripts/build_plush_f7f7f7.sh              # rebuild all 8 finals from cached intermediates + QC
./scripts/build_plush_f7f7f7.sh --no-cache   # full from-scratch: re-fetch Photoroom + Gemini (see caveats)
node scripts/qc_plush_f7f7f7.mjs             # QC only (checks + rebuilds the compare sheet)
```

The default run regenerates every **composite** from scratch (no final cache) but reuses the cached
Photoroom/Gemini intermediates. `--no-cache` also wipes and re-fetches those — **only do this knowing
the Gemini stages are non-deterministic** (see caveats): the otter shadow can come back blank and the
drawn strands can shift.

## The two techniques, chosen by shadow availability

The split is about **whether Photoroom produced a cast shadow** (sampled from the darkest ground pixel
of `outputs/work/<sku>/shadow.jpg`, matte alpha < 0.1):

| SKU | Product | Photoroom shadow | Technique | Shadow source |
|---|---|---|---|---|
| PE317642 | panda | yes | **band** | Photoroom |
| PE371748 | cat | yes | **band** | Photoroom |
| PE964848 | orangutan | yes | **band** | Photoroom |
| PE936323 | otter (flat, lies down) | **blank** | **dehalo** | **Gemini** |

Within each technique, FUR EDGES vs NO FUR differ only by which Gemini edge output is used and whether
fur strands are drawn:

| | FUR EDGES | NO FUR |
|---|---|---|
| band (3 SKUs) | `--gem B` (strands) | `--gem A --nostrands` |
| dehalo (otter) | strand prompt | `--nostrands` (recolor-only prompt) |

## Path A — band (has a Photoroom shadow)

Script: [`scripts/exp_fur_edge_finalize_shadow.mjs`](../scripts/exp_fur_edge_finalize_shadow.mjs)

Rebuilds the silhouette from the real product deep inside and Gemini's cleaned fur at the edge, over
the Photoroom shadow, relit, on F7F7F7:

```
I    = smoothstep(0.55, 0.92, blur(alpha, 90))        // deep-interior selector (R=90)
pw   = a · I                                           // real product only deep inside
P    = subj · pw + gem · (1 - pw)                       // band product: Gemini fur fills the rim
gemFur = smoothstep(0.10, 0.28, 1 - min(gem)/255)      // extend coverage for DRAWN strands (gem_B)
cov  = --nostrands ? smoothstep(0.10,0.55,a)           //   NO FUR: matte alpha only (see the otter note)
                   : max(smoothstep(0.10,0.55,a), gemFur)
rl   = 1 + ((lm − mean)/128) · 0.08 · gate(a)          // product-only relight from relit.jpg
out  = P · rl · cov  +  (F7F7F7 · sf) · (1 − cov)       // sf = luma(shadow.jpg)/255
```

- `gem` = `outputs/experiments/fur_edge/<sku>_gem_{A,B}.jpg` (Gemini de-halo of the white composite).
- **`--nostrands` drops `gemFur`.** `gemFur` exists to pull Gemini's *drawn strands* (gem_B) into
  coverage. With gem_A (no strands) it instead pulls gem's own **baked cast shadow** in as "product",
  which then double-composites against the ground shadow → a **second shadow**. Coverage = matte alpha
  only fixes it; the 3 non-otter edges are pixel-identical with gemFur on/off (their edge comes from
  the real product via `P`, not gemFur), so there's no downside.

## Path B — dehalo (blank Photoroom shadow → Gemini shadow)

Script: [`scripts/exp_dehalo.mjs`](../scripts/exp_dehalo.mjs)

```
node --env-file=.env scripts/exp_dehalo.mjs PE936323 --bg F7F7F7 --relight 0.08              # FUR EDGES
node --env-file=.env scripts/exp_dehalo.mjs PE936323 --bg F7F7F7 --relight 0.08 --nostrands  # NO FUR
```

A border **swap** over the real product: keep the pixel-real interior, replace only a wide silhouette
border (`m = 1 − smoothstep(0.72, 0.97, blur(alpha,18))`) with Gemini's de-halo'd edge, and let
Gemini's cast shadow ride onto the ground. Two flags:

- `--nostrands` — recolor-only prompt (no drawn strands) written to its own `dehalo_nostrand*` cache so
  it never collides with the strand output.
- `--relight` — the same 0.08 product-only relight as the band path (dehalo sits on the **no-relight**
  `final_F7F7F7` base and applies relight itself, gated by matte alpha so the shadow/ground are untouched).

### Why the otter uses dehalo and not the band

The band grounds from a shadow **render** via `sf`. The 3 non-otter share the *exact frame* with their
matte (Photoroom pads around the product at `padding: 0.10`, invariant 1), so product edges line up.
The otter has no Photoroom shadow, so the band would ground from the **harvested** Gemini shadow — a
*separate* render where Gemini reframes/rescales the product, so its silhouette doesn't align with the
matte and a **band/outline** appears around the whole body. dehalo avoids this: it never grounds from a
misaligned render — it's a border swap on the matte frame, and the shadow rides in through the de-halo
output. (The otter's dehalo edge measures a touch brighter than the band's, but the band's misaligned
ring is worse; dehalo wins.)

## Caveats — each learned the hard way

- **Gemini is non-deterministic.** The otter's cast shadow in the de-halo pass is not guaranteed
  (`--no-cache` may bring it back **blank**), and the drawn strands (gem_B) shift between runs. The good
  results are reproducible **because the Gemini outputs are cached** (`outputs/experiments/fur_edge/`,
  `dehalo_F7F7F7/`, `dehalo_nostrand_F7F7F7/`). Don't wipe them casually. If a regen returns a shadowless
  otter, harvest an explicit shadow via [`src/shadow-patch.mjs`](../src/shadow-patch.mjs).
- **Never rebuild the background with a lagging mask.** Every halo in development came from
  reconstructing coverage with blurred / flood-filled / gemFur-on-a-shadow masks that lag the true
  silhouette. Coverage comes from the **matte alpha**; the edge is filled from Gemini via `P` / the
  border swap. Keep it that way.
- **Two shadows = two shadow sources.** If a plush shows a double shadow, a second shadow source got
  into coverage (the otter's gemFur-picks-up-gem's-shadow bug). One shadow ⇒ one source.
- **White fur on F7F7F7 stays blunt.** Pale fur (the cat's white paws) has almost no contrast against
  F7F7F7, so its fine edge can't be recovered against that background — an inherent limit.

## QC

[`scripts/qc_plush_f7f7f7.mjs`](../scripts/qc_plush_f7f7f7.mjs) checks each final: present · **4000²**
native · **cast shadow grounded** (darkest ground pixel < 240) · **fringe not blown out** to bg (halo
guard), prints a PASS/WARN table, and rebuilds the compare sheet. Exit code is non-zero on any FAIL.
