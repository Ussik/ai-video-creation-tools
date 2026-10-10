# Task Plan: Canvas periodic refresh stability

## Goal
Stop periodic canvas jumping/display glitches while preserving real task updates, edits and viewport controls.

## Next Step
Complete: deliver the verified canvas stability repair.

## Current Phase
Complete

## Phases
- [x] Audit polling and canvas loading dependencies.
- [x] Reproduce view/node changes with mocked periodic detail updates.
- [x] Fix root causes without disturbing existing workspace changes.
- [x] Run focused regressions, production build and browser verification.
- [x] Clean temporary fixtures/services and report result.

## Decisions
- Keep existing project/job updates; preserve unchanged data references and user viewport where possible.
- Use mocked requests/temporary fixtures; do not mutate real project data or run generation.
- No commit/push requested.
