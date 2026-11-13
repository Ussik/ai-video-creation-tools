# Prompt Body Modal Redesign Implementation Plan

> **For agentic workers:** Implement the approved prototype with the local parent/worker workflow. User has authorized implementation; no additional design approval is pending.

**Goal:** Make prose the primary editing surface, show fixed settings on demand, and refine prose in a separate draft modal.

**Architecture:** Preserve the existing TipTap document and section metadata. React portal controls provide compact fixed-setting summary and read-only modals without moving editable DOM. Refinement captures the opening source, stages drafts independently, and writes only on explicit application.

**Tech Stack:** React 19, Mantine 9, TipTap 3, TypeScript, Node test runner.

**Spec:** `/Users/caoyanzu/.codex/visualizations/2026/11/02/01a19a2f-b298-71c2-af9a-f77e4f26bb3e/prompt-editor-redesign-requirements.md` and adjacent `prompt-editor-body-modal-redesign.html`.

## Global Constraints

- 可润色这些描述的表达，但不能改变既定事实和展示要求。
- Independent fixed blocks, metadata, reference identity/order/bindings, model and generation parameters stay unchanged on apply.
- Support all 11 existing requirement types; display only active entries and do not duplicate board primary prose.
- No automatic migration or silent split of historical board content.
- Preserve canvas, media candidates, reference controls and generation footer.
- Preserve existing unrelated edits; this task does not commit or push.

## Review Focus

- Nested refinement modal must close independently of enlarged composer and retain its focus context.
- Cancel during pending work or after a result must not write back or accept a late response.
- Continued refinement starts from the edited draft while retaining the original opening prose comparison.
- Changed source, requirements, reference bindings or parameters invalidate an old result; empty or known conflicting drafts cannot apply.
- Board primary content remains editable once; its facts and views are protected by the refinement contract, with deterministic checks where available and no claim of perfect semantic validation.

### Task 1: Prose-first editor and compact settings

**Files:** `web/src/features/canvas/CanvasPromptEditor.tsx`, `CanvasPromptRequirements.tsx`, `canvas-prompt-requirements.css`, `canvas-prompt-editor.css`, `web/test/canvas-prompt-editor.test.tsx`.

**Interfaces:** Reuse `CanvasPromptRequirementEntry`, existing portal host, original editable content and `fullPrompt`; fixed-detail UI consumes serialized text read-only.

- [x] Update editor regression assertions for expanded prose, active-only compact summary, primary exclusion and read-only settings/full-preview modals.
- [x] Implement compact summary, independent fixed details and full prompt preview with Mantine controls; preserve document/history and source-resolution behavior.
- [x] Run focused editor/requirements tests; verify folded separator fix and reference editing remain intact.

### Task 2: Independent phased refinement modal

**Files:** `web/src/features/skills/PromptSkillAction.tsx`, `prompt-skill-action.css`, `web/src/features/canvas/ProjectCanvas.tsx`, `web/test/prompt-skill-action.test.tsx`.

**Interfaces:** Preserve `onApply(prompt, body?, document?)`; use existing scope helpers; only explicit “应用正文” invokes it.

- [x] Add lifecycle coverage for no writeback on cancel, original comparison across continued edits, stale/empty refusal and independent modal close.
- [x] Implement initial/running/result/continue views, compact optional configuration, clear cancellation and editable draft; remove composer inline invocation.
- [x] Run focused action and integration tests.

### Task 3: Refinement protection contract

**Files:** `backend/src/modules/skills/skill-routes.ts`, relevant scope/shared helpers as necessary, `backend/test/prompt-refinement-body.test.ts`, `web/test/prompt-refinement-scope.test.ts`.

**Interfaces:** Maintain current response shape unless additive checks are needed; deterministic known conflict failures must prevent application.

- [x] Add contract tests that board facts/views remain protected even with adjustment requests, and structural fixed blocks remain unchanged.
- [x] Correct backend instructions and expose/block detectable conflicts without inventing semantic certainty or migrating saved data.
- [x] Run focused backend/scope tests.

### Task 4: Integration acceptance

- [x] Run `npm run check`, `npm run build`, and relevant web/backend tests; expand only for failures or unresolved integration concerns.
- [x] Verify actual image/board UI, fixed-detail and preview dialogs, nested modal close, and narrow width in one new browser TaskSpace; cover video composition and writeback with existing integration tests. No paid generation.
- [x] Remove temporary acceptance fixtures/services, preserve app ports 8888/8000, finish the TaskSpace once, and report results and actual validation limits.

## Completed validation

- Root `npm run build` passed, including architecture, Mantine UI guard, shared/backend/web TypeScript and Vite build. Existing large-chunk notice remains.
- Full web suite: 1319/1319 passed. Added final removed-primary regression and modal focus fix then passed 3 focused editor cases and 7 toolbar cases. Four canvas integration files: 124/124 passed.
- Backend refinement/body/board/Seedance coverage: 65/65 passed. Scope/requirement unit coverage: 15/15 passed.
- Ego TaskSpace 29: actual existing board and image node; fixed detail/full preview readonly; cancel and continued mock draft preserve source; original comparison retained; Escape keeps enlarged composer; Tab stays in modal; actual width 390px with no overflow, result comparison stacked. Finished once; normal app servers preserved.
- Browser refinement used a local intercepted response, never a real model. No real-media generation or real project prompt writeback performed during browser acceptance; apply semantics covered by integration tests.
- Deterministic protection covers explicit object/version/view and parameter/reference conflicts. Arbitrary free-form factual equivalence still requires human comparison.
