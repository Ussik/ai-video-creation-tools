# Storyboard skill configuration refinement

## Goal
Replace the full-width top skill strip with a compact, contextual configuration in the right planning panel. Show temporary/default scope honestly, make default management secondary, and show actual usage in preview.

## Phases
- [x] Audit screenshot and existing planner/selector implementation.
- [x] Move planning skill control into right setup panel and add scope/auxiliary metadata.
- [x] Refine planner-specific skill popover (delegated).
- [x] Add actual-use preview summary and preserve generation state/default behaviour.
- [x] Run relevant existing tests and build; mocked browser visual verification.
- [x] Clean fixtures and show the result.

## Constraints
No backend or skill instruction changes. No real model calls or project writes for QA. Preserve all preexisting work; keep other selector consumers unchanged.
