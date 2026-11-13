# Pending Reference Connections Implementation Plan

> **For agentic workers:** Implement the task in this session with a delegated integration test and an independent review.

**Goal:** Automatically added reference image nodes immediately show their relationship to the consuming video; pending references use dashed lines and confirmed image inputs use solid lines.

**Architecture:** Derive pending connections from active shot bindings and existing profile nodes, including saved video nodes without the legacy dependency flag. Keep these connections in the display graph so pending images cannot enter generation requests. Render the derived edge according to whether it pins a confirmed image.

**Tech Stack:** TypeScript, React Flow, Node test runner, JSDOM.

**Spec:** User-approved behavior in this chat: pending/generating/unconfirmed reference images use dashed connections; confirmed effective references use solid connections.

## Global Constraints

- Preserve existing workspace changes and saved canvas data.
- Use image → video direction; do not submit model generation jobs during verification.
- Respect current video modes, binding usage, explicit dependency opt-out, reference snapshots, and duplicate prevention.

## Review Focus

- Existing videos without `visual_dependencies` must gain pending connections without migration.
- Generated but unconfirmed candidates must stay pending and outside submitted references.
- Confirmation must replace the pending connection with one solid reference connection.
- Inactive scopes, first-frame mode, optional missing references, and explicit opt-out must not gain pending connections.
- Explicit edges must not acquire duplicate automatic connections; saved snapshots must retain their selected image.

---

### Task 1: Show reference readiness on canvas connections

**Files:**
- Modify: `web/src/features/canvas/canvas-visual-profiles.ts` — derive pending reference connections for targets with default dependency settings.
- Modify: `web/src/features/canvas/ProjectCanvas.tsx` — dashed pending edges and readiness labels.
- Test: `web/test/canvas-visual-profiles.test.ts` — default behavior, scope, opt-out, snapshots, and deduplication.
- Test: `web/test/canvas-video-reference-integration.test.tsx` — actual canvas pending → candidate → confirmed lifecycle.

**Interfaces:**
- Consumes: `automaticVisualReferenceEdges(graph, detail, models)` and the existing automatic edge renderer.
- Produces: Display-only edges without `reference_asset_id` while pending; existing pinned image edges when confirmed. No persistence or generation API changes.

- [x] Add regression assertions for missing references on saved video/image targets, inactive modes, and explicit edges.
- [x] Run the focused tests and confirm the missing pending connection failure.
- [x] Default pending dependencies to enabled unless explicitly disabled, retaining the existing eligibility checks.
- [x] Render pending automatic references with `strokeDasharray: '6 5'` and a readiness label; keep confirmed references solid.
- [x] Verify the integration lifecycle, relevant existing tests, UI checks, and web build; inspect any failures against the pre-existing workspace state.
- [x] Independently review the scoped patch and resolve actionable findings.

Validation: All 31 visual-profile unit tests and 34 selected reference, handoff, snapshot, canvas refresh, and inheritance regressions passed. The new component lifecycle tests failed before the fix and passed afterward for both newly created and saved videos. `npm run check` and `npm run build --workspace=web` passed. Independent review found no blocking issue. Verification used mocked generation requests without live model calls.

Follow-up: The user requested uniform lines after reviewing a screenshot. All canvas connections now use solid 1.5px strokes that retain their width when zooming; selection changes color. Pending reference titles and eligibility remain in place, and the lifecycle assertions now verify the unified appearance.
