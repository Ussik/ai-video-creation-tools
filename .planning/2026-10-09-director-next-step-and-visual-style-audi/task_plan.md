# Director next-step and visual-style audit

## Goal
Remove the redundant next-stage name beside the action button. Audit why confirmed anime style was lost during visual asset generation and recommend consistent controls across images and videos. Broad style enforcement is analysis/design in this request.

## Phases
- [x] Inspect screenshots and locate redundant footer label.
- [x] Audit confirmed settings, assets, shots, provider prompts, references and stale data.
- [x] Verify the narrow UI change and report evidence and recommendations.

## Constraints
Preserve existing dirty work. No paid model calls, real project writes, commit or push. Read actual project data only through direct read-only DB access when needed.

## Errors
- A read of root package.json failed because the project has separate backend and web packages; switched to web/package.json. No mutations or runtime effect.
