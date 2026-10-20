#!/usr/bin/env bash
# Composite regression on CACHED stages, no API calls. Any cache miss fails (fake keys) and costs nothing.
#
#   scripts/check_composite.sh baseline            # before a change: records finals under outputs/check/baseline
#   scripts/check_composite.sh compare             # after:  re-renders and diffs byte for byte against the baseline
#
# Covers every composite path: opaque on white and grey, highlights auto/off, shade, exposure, strength,
# no-relight, flatlay, short preset, non-HD matte, transparent, render-only with and without relight.
# Needs the listed SKUs' stages in outputs/work (they were cached on the machine that ran the 2026-10
# category run); edit CASES if yours differ. Deletes and regenerates those SKUs' cached finals.
set -u
MODE=${1:-compare}; ROOT=outputs/check; OUT=$ROOT/$MODE; mkdir -p "$OUT"
export PHOTOROOM_KEY=fake GEMINI_KEY=fake
CASES=(
  "opaque_white      PE979531,PE1016720,PE920580"
  "opaque_gray       PE979531,PE935669   --bg E8E8E8"
  "ha_sh65           PE638683            --highlights auto --shade 0.65"
  "off_e97_st40      PE774419            --highlights off --exposure 0.97 --strength 0.4"
  "no_relight        PE920580            --no-relight"
  "flatlay_norelight PE419173            --subject-pose flatlay --no-relight"
  "short_preset      PE979531            --shadow short"
  "no_hd             PE979531            --no-hd"
  "transparent       PE729361            --mode transparent"
  "render_only_relit PE729361"
  "render_only_flat  PE729361            --no-relight"
)
fail=0
for c in "${CASES[@]}"; do
  read -r name skus flags <<<"$c"
  for s in ${skus//,/ }; do rm -f "outputs/work/$s"/final*.jpg; done
  # shellcheck disable=SC2086
  node scripts/run_pipeline.mjs --skus "$skus" --out "$OUT/$name" --sheet "$OUT/$name.jpg" $flags >"$OUT/$name.log" 2>&1
  r=$(grep -oE 'Done\. [0-9]+ ok, [0-9]+ failed' "$OUT/$name.log" || echo "no result"); printf '%-18s %s\n' "$name" "$r"
  [[ $r == *" 0 failed" ]] || fail=1
done
if [[ $MODE == compare ]]; then
  if [[ ! -d $ROOT/baseline ]]; then echo "no baseline: run '$0 baseline' first"; exit 2; fi
  if diff -rq "$ROOT/baseline" "$OUT" --exclude='*.log' >/dev/null; then echo "IDENTICAL to baseline"; else echo "DIFFERS from baseline:"; diff -rq "$ROOT/baseline" "$OUT" --exclude='*.log'; fail=1; fi
fi
exit $fail
