# Configuration reference

Every setting the pipeline reads, how it resolves, and what it invalidates. Verified against
`scripts/run_pipeline.mjs` at commit `5236c2b` on 2026-10-15. What the settings do to pixels:
`docs/pipeline.md`. Why the defaults are what they are: `docs/decisions.md`.

## Resolution

Per input group folder: **CLI flag > `inputs/<group>/group.json` > built-in default.**
A flag counts only if it was passed. Settings are resolved and validated for every group before any
API call; one invalid value stops the whole run.

Configuration is **per group, not per SKU**. A group that mixes item types (for example top-down rugs and
angled boards in `group_flat`) is rendered with the group's settings, and the odd SKUs are re-run with
`--skus` and the overriding flag. `manifest.json` files record provenance only; the pipeline never reads
them.

## Settings that change a stage

| Setting | CLI | group.json | Default | Values | Stage it changes | Calls on change |
|---|---|---|---|---|---|---|
| Mode | `--mode`, or `--transparent`, `--render-only` | `mode` | `opaque` | `opaque`, `transparent`, `render-only` | plate, shadow bg, prompt, composite | **none on white: cached shadow, matte and relit are reused** (gap, see below). `render-only` on a non-white bg: new shadow, plus Gemini if relight is on. |
| Shadow preset | `--shadow` | `shadow` | `long` | `long`, `short` | shadow | Photoroom + Gemini |
| Subject pose | `--subject-pose` | `subjectPose` | `upright` | `upright`, `flatlay` | shadow | Photoroom + Gemini |
| Relight | `--no-relight`, `--relight` | `relight` | `true` | boolean | relight | Gemini when turned on, **unless a final already exists**: relight is not in the final's key, so the old final is reused |
| HD matte | `--no-hd` | — | on | — | matte | Photoroom |
| Framing | `--no-plate` | — | off | — | plate, padding, every stage | everything |

`--no-relight` wins over `--relight`. `--hd` is accepted and does nothing; HD has been the default since
2026-10-15.

## Settings that change only the composite

Changing any of these costs no API call, except `bg` in `render-only`, which needs a new shadow render
and, with relight on, a new Gemini call. Values are rounded to hundredths in cache names, so two values
that round alike share a cached final.

| Setting | CLI | group.json | Default | Valid range | Effect |
|---|---|---|---|---|---|
| Background | `--bg` | `bg` | `FFFFFF` | 6 hex digits | Output background. `transparent` mode accepts only `FFFFFF`. |
| Strength | `--strength` | `strength` | `0.25` | not validated | Relight amount. |
| Highlights | `--highlights`, `--shade-only` (= `off`) | `highlights`; legacy `shadeOnly: true` = `off` | `on` | `on`, `off`, `auto` | Bright half of the lightmap: full, none, or scaled by measured headroom. |
| Shade | `--shade` | `shade` | `1` | 0 to 1 | Dark half of the lightmap. |
| Exposure | `--exposure` | `exposure` | `1` | above 0.5, up to 1.5 | Flat multiplier on the product. Ignored in `render-only`. |

## Run-scope flags (not per group)

| Flag | Default | Effect |
|---|---|---|
| `--skus a,b` | all | Limit to these SKU names. |
| `--group name` | all | Limit to one top-level input folder. |
| `--out dir` | `outputs/finals` | Final images. Input folder structure is mirrored under it. |
| `--sheet path` | `outputs/contact_sheet.jpg` | Contact sheet; `_<group>` is appended for grouped inputs. |
| `--no-cache` | off | Ignore every cache file; still write new ones. |
| `--debug` | off | JSONL log of every request, response and composite parameter in `outputs/debug/run-<ts>.jsonl`, plus every stage's input and output image in `outputs/work/<sku>/debug/`: `00_input_source`, `01_plate_input` (the bytes sent to both Photoroom calls), `02_shadow_output`, `03_matte_output`, `04_relight_input`, `05_relight_output`, `99_final_output`. |

## Compatibility

| Combination | Result |
|---|---|
| `transparent` + non-white `bg` | Rejected before any work. |
| `render-only` + non-white `bg` | Allowed. Photoroom renders the shadow on that colour; cached separately. |
| `render-only` + relight off | Final is the shadow render byte-for-byte; no matte call. |
| `render-only` + `exposure` | Accepted, has no effect. |
| `--no-plate` + any mode | Padding switches to 0.0838 and `referenceBox=originalImage` is sent. Calibrated on sources whose product fills ~96% of the frame. |

## Committed group settings

| Group | Settings | Groups without a `group.json` use defaults |
|---|---|---|
| `group_chair`, `group_sofa` | opaque, strength 0.25, long, FFFFFF | (explicit defaults) |
| `group_fur`, `group_plush` | opaque, **strength 0.08**, long, FFFFFF | |
| `group_glass`, `group_glassware` | **render-only**, long, FFFFFF; relight not disabled, so it runs | |
| none | — | dark, flat, legs, lit, offwhite, open, plant, reflective, small, tall, textile, white |

`docs/categories.md` recommends `highlights: auto` for white, tall and reflective and `subjectPose: flatlay`
for top-down items; none of that is in a `group.json` yet.

## Secrets

`.env`, never committed, read with `node --env-file=.env`:

| Variable | Required |
|---|---|
| `PHOTOROOM_KEY` | Always. Sandbox keys (`sandbox_` prefix) are limited to 60 calls/min and may watermark output. |
| `GEMINI_KEY` | Unless `--no-relight`. |

## Cache file names

All under `outputs/work/<sku>/`. Suffixes are omitted at their default value.

```
shadow{P}{N}{R}.jpg
matte{N}{H}.png
relit{P}{N}.jpg                       opaque, transparent
relit{P}{N}{R}.jpg                    render-only
final{P}{M}{N}{H}{L}{E}{S}{D}_{BG}.jpg
```

| Token | Values | Source |
|---|---|---|
| `{P}` | `_short` if preset short, then `_flatlay` if pose flatlay | shadow preset, pose |
| `{N}` | `_np` | `--no-plate` |
| `{R}` | `_<BG>` when render-only and bg ≠ FFFFFF | render-only background |
| `{H}` | `_hd` (default); empty with `--no-hd` | HD matte |
| `{M}` | `_t` transparent, `_r` render-only | mode |
| `{L}` | `_s` highlights off, `_ha` auto | highlights |
| `{E}` | `_e<exposure×100>` | exposure |
| `{S}` | `_st<strength×100>` | strength |
| `{D}` | `_sh<shade×100>` | shade |
| `{BG}` | hex, always present | background |

Example: `final_flatlay_hd_ha_st40_F7F7F7.jpg` is flatlay pose, HD matte, highlights auto, strength 0.40,
on F7F7F7.

**Not in any key:** the source image's content; relight on/off (final); mode (shadow, matte, relit);
model, prompt or code version (all). Mode selects the plate (`makePlate` for opaque, `squarePlate` for
glass) and the Gemini prompt, so a SKU rendered once as opaque and then switched to a glass mode on
white reuses shadow, matte and lightmap made the opaque way. Delete the SKU's work folder when changing
its mode. See `docs/pipeline.md` section 7.
A run skips a SKU entirely when its final file exists.

Older caches written before HD became the default are named `matte.png` and `final..._<BG>.jpg` without
`_hd`; they are still read by `--no-hd` runs.
