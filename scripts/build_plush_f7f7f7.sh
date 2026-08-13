#!/usr/bin/env bash
# Build the plush F7F7F7 deliverables — THREE versions per SKU, in ONE folder:
#   <sku>_normal.jpg   standard pipeline (opaque composite + Photoroom shadow + 0.08 relight) = baseline
#   <sku>_furedge.jpg  de-halo'd edge WITH drawn fur strands
#   <sku>_nofur.jpg    de-halo'd edge, NO strands
# All on F7F7F7, all relit 0.08. Output: outputs/finals_plush_f7f7f7_all/group_plush/
#
# Default: regenerate every composite from scratch (no final cache), reusing cached Photoroom/Gemini
#          intermediates. Deterministic and safe.
# --no-cache: also WIPE outputs/work/<sku> + the Gemini edge caches and re-fetch the whole chain.
#          WARNING: the Gemini stages are non-deterministic (CLAUDE.md invariants 3-4) — the otter's
#          cast shadow can come back blank and the drawn strands can shift. Eyeball the QC sheet.
#
#   ./scripts/build_plush_f7f7f7.sh              # rebuild from cached intermediates
#   ./scripts/build_plush_f7f7f7.sh --no-cache   # full from-scratch (re-fetch Photoroom + Gemini)
set -euo pipefail
cd "$(dirname "$0")/.."

SKUS3="PE317642 PE371748 PE964848"   # panda, cat, orangutan — real Photoroom cast shadow
OTTER="PE936323"                     # flat, lies down — blank Photoroom shadow → Gemini shadow
BG=F7F7F7; BGL=f7f7f7
NODE="node --env-file=.env"
SCRATCH=outputs/work/_build_scratch

NOCACHE=0
[ "${1:-}" = "--no-cache" ] && NOCACHE=1

ALL=outputs/finals_plush_f7f7f7_all/group_plush     # the ONE deliverable folder
BAND=outputs/finals_plush_furedge_shadow_${BGL}/group_plush   # intermediate (gitignored)
mkdir -p "$ALL" "$SCRATCH"

if [ "$NOCACHE" = "1" ]; then
  echo "!! --no-cache: wiping outputs/work/<sku> + Gemini edge caches, regenerating from scratch."
  echo "!! Gemini is non-deterministic — the otter shadow and fur strands may change. Check the QC sheet."
  for s in $SKUS3 $OTTER; do rm -rf "outputs/work/$s"; done
  rm -rf outputs/experiments/fur_edge \
         outputs/experiments/dehalo_${BG} outputs/experiments/dehalo_nostrand_${BG}
fi

echo "== 1/5  pipeline intermediates + NORMAL baseline =="
for s in $SKUS3 $OTTER; do
  # matte + shadow + relit + relit final_FFFFFF (Gemini edge input). Skip if relit.jpg already cached.
  if [ "$NOCACHE" = "1" ] || [ ! -f "outputs/work/$s/relit.jpg" ]; then
    $NODE scripts/run_pipeline.mjs --skus "$s" --group group_plush --bg FFFFFF \
      --out "$SCRATCH" --sheet "$SCRATCH/sheet_white.jpg"
  fi
  # NORMAL baseline = standard RELIT F7F7F7 final. Cache key ignores relight, so force a re-render.
  rm -f "outputs/work/$s/final_${BG}.jpg"
  $NODE scripts/run_pipeline.mjs --skus "$s" --group group_plush --bg "$BG" \
    --out "$SCRATCH" --sheet "$SCRATCH/sheet_normal.jpg"
  cp "$SCRATCH/group_plush/$s.jpg" "$ALL/${s}_normal.jpg"
  # dehalo's base (`before`) must be a NO-RELIGHT grey final — regenerate it after grabbing normal.
  rm -f "outputs/work/$s/final_${BG}.jpg"
  $NODE scripts/run_pipeline.mjs --skus "$s" --group group_plush --bg "$BG" --no-relight \
    --out "$SCRATCH" --sheet "$SCRATCH/sheet_grey.jpg"
done

echo "== 2/5  Gemini edge outputs (gem_A recolor, gem_B strands) =="
$NODE scripts/exp_fur_edge.mjs $SKUS3 $OTTER   # cache-first; regenerated only under --no-cache

echo "== 3/5  FUR EDGES =="
$NODE scripts/exp_fur_edge_finalize_shadow.mjs $SKUS3 --bg "$BG" --R 90 --strength 0.08 --gem B
for s in $SKUS3; do cp "$BAND/$s.jpg" "$ALL/${s}_furedge.jpg"; done
$NODE scripts/exp_dehalo.mjs "$OTTER" --bg "$BG" --relight 0.08
cp "outputs/experiments/dehalo_${BG}/${OTTER}_hybrid.jpg" "$ALL/${OTTER}_furedge.jpg"

echo "== 4/5  NO FUR =="
$NODE scripts/exp_fur_edge_finalize_shadow.mjs $SKUS3 --bg "$BG" --R 90 --strength 0.08 --gem A --nostrands
for s in $SKUS3; do cp "$BAND/$s.jpg" "$ALL/${s}_nofur.jpg"; done
$NODE scripts/exp_dehalo.mjs "$OTTER" --bg "$BG" --nostrands --relight 0.08
cp "outputs/experiments/dehalo_nostrand_${BG}/${OTTER}_hybrid.jpg" "$ALL/${OTTER}_nofur.jpg"

echo "== 5/5  QC + 3-column compare sheet =="
$NODE scripts/qc_plush_f7f7f7.mjs

echo "done."
