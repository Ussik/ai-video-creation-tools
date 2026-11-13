# Unified prompt editor implementation plan

**Goal:** Apply the approved main-content and unified-requirements prototype to the actual canvas composer.

**Architecture:** Keep one TipTap document, its content DOM, stable section/reference IDs and undo history. Add a presentation-only requirements catalogue and selection; reuse existing node views for editing the selected section and the existing generation-parameter panel. Refinement exposes only the permitted main content and rebuilds its apply payload against the current protected document.

**Tech Stack:** React, TipTap/ProseMirror, Mantine, existing canvas CSS and Node test runner.

**Spec:** `/Users/caoyanzu/.codex/visualizations/2026/11/02/01a19a2f-b298-71c2-af9a-f77e4f26bb3e/prompt-editor-unified.html`

**Execution:** Implement in this session with independent refinement work and review. The user has approved implementing the prototype.

## Global constraints

- Preserve the original names of all 11 managed requirement types.
- Actual node context determines task applicability; existing active blocks always remain visible and effective. Missing blocks with unknown context are unconfigured, not deleted.
- Setting-board main content includes object definition, views, layout and supplementary creative prose. Other image/video tasks only refine their main creative prose.
- Refinement must preserve every currently active protected block and all source metadata; removed blocks must not be restored.
- Parameters have one authoritative control panel. Image/video output semantics remain visible and editable in their existing blocks.
- Do not move ProseMirror content DOM, rebuild the document on selection, delete tombstones by name, combine duplicate identities, or change reference bindings/order as a presentation side effect.
- Keep copy/paste, source-conflict resolution and reference undo working.
- Implement real task behavior; omit the prototype's task-demo switcher.

## Review focus

- Existing same-name blocks and a same-name tombstone retain separate identities.
- Keyboard navigation into a hidden requirement reveals the corresponding detail without changing content.
- Switching requirement views, selecting a type or opening the editor creates no save/undo event.
- A changed body, requirement, reference, parameter, model, skill or adjustment invalidates an old refinement result.
- Narrow canvas containers reflow the same content DOM without clipping or losing typing focus.

## Task 1: Unified requirement presentation

Files: `web/src/features/canvas/CanvasPromptEditor.tsx`, `canvas-prompt-presentation.ts`, new `CanvasPromptRequirements.tsx` / `canvas-prompt-requirements.ts` / `canvas-prompt-requirements.css`, `web/test/canvas-prompt-editor.test.tsx` and a catalogue helper test.

- [x] Build a catalogue from all 11 shared names and actual active sections, retaining each block ID and source state. Classify missing entries from the supplied modality/visual-board context.
- [x] Add optional unified-layout props and a stable noneditable ProseMirror decoration host for requirement controls. React portals are permitted only for presentation controls; section content remains in its original node view.
- [x] Lay out main prose first, then requirements heading and current/all selector, a compact list and the selected original node view. Use a single-column presentation in narrow containers.
- [x] Reuse section menus, source actions, reference chips and the parameter panel callback. Add a main-content locator for the setting-board primary and full-prompt preview as secondary actions.
- [x] Extend meaningful editor tests for no-write selection, all 11 types, duplicate/tombstone identities, parameter actions, keyboard reveal and reference/section undo.

## Task 2: Refinement scope and preview

Files: `web/src/features/skills/PromptSkillAction.tsx`, `prompt-skill-action.css`, new `prompt-refinement-scope.ts`, related component/helper tests.

- [x] Extract the permitted editable content from the current source document. Responses and manual draft edits may only supply that content.
- [x] Show the exact scope, before/after content and a protected-context summary. Add optional inline rendering while preserving existing modal callers.
- [x] Apply only main content against the current source document, preserving protected text, IDs, metadata, deleted records and references. Reject managed markers in draft prose.
- [x] Preserve and strengthen stale-result detection, including skill revisions/model configuration, and test ordinary/setting-board scopes and altered contexts.

## Task 3: Integration and acceptance

Files: `web/src/features/canvas/ProjectCanvas.tsx` and relevant existing tests.

- [x] Enable unified presentation in the actual composer, supply actual modality, and place the inline refinement action alongside main content. Reuse the existing generation parameter panel.
- [x] Run affected editor/composition/refinement/reference tests, UI/architecture checks, TypeScript and production build.
- [x] Inspect the actual running page at normal and narrow widths. Exercise all-type browsing, main collapse, parameter action, reference/source behavior and safe refinement preview without real generation.
- [x] Report the implemented behavior, validation and any runtime limitations. Leave changes reviewable in the working tree.

## Acceptance evidence

- Full frontend test suite: 1,313 passed, zero failures (`/tmp/unified-web-final-tests.log`).
- Architecture/UI guards and TypeScript passed. Production web build passed; existing chunk-size warning remains.
- Actual page: board and ordinary image nodes opened; current/all 11 requirements browsed, body folding and inline refinement scope inspected, existing parameter panel opened, 390px layout verified with selected detail directly below its row and no horizontal overflow. No real generation was submitted.
- Regression fixes found during acceptance: each TipTap editor now owns its widget host under StrictMode; choosing another requirement releases the hidden editor caret; outer editor styles no longer hide or restyle compact refinement inputs; only candidate prose reference numbers are normalized.
- Temporary acceptance fixture is removed before delivery. Changes remain in the working tree.
