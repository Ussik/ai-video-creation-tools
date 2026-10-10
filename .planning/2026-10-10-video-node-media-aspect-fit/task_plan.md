# Video node media aspect fit

## Goal
Display video generation results at the intrinsic video aspect ratio, matching image generation nodes with no letterboxing.

## Phases
- [x] Locate image-only fitting, minimum size and CSS behavior.
- [x] Extend generation result fitting to video metadata and proportional resize.
- [x] Verify metadata fitting, selected playback, refresh stability, existing layout tests and frontend build.
- [x] Remove mock preview fixtures and deliver.

## Constraints
Preserve existing local edits. Read video metadata only; do not generate or modify real media or projects. Avoid cropping frames. Preserve asset identity guards and idempotent fits. Plain media nodes have separate action rails; target the generation result nodes shown in the screenshot.
