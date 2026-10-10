# Storyboard reference prerequisites

## Goal
Restore visual reference preparation between professional storyboard planning and canvas generation.

## Phases
- [x] Identify skipped preparation route and canvas entry behavior.
- [x] Restore explicit reference preparation, versioned incremental reuse and backend import guard.
- [x] Explain preparation in planner and keep stage skill switching, status and retries visible.
- [x] Prioritize required missing reference nodes on canvas handoff.
- [x] Run focused flow tests, builds and mocked UI checks.
- [x] Clean temporary previews and deliver.

## Decisions
- Save planned shots first; then obtain a fresh preparation signature, analyze missing references and commit them before canvas import. Each stage uses current versions; retries reuse completed saves.
- Import both reference-information nodes and storyboard nodes. Image generation stays under user control. Required unconfirmed boards block the dependent storyboard.
- Existing board definitions, confirmed images, optional bindings and historical snapshots remain reusable.
- Preserve all preexisting workspace changes. No real project writes or model calls in verification.

## Delegation
- Backend preparation metadata/guard/fingerprint and backend tests: storyboard_reference_backend_audit.
- Canvas focus selection and handoff tests: storyboard_reference_canvas_audit.
- Root: planner orchestration and frontend tests, visual verification and plan files.
