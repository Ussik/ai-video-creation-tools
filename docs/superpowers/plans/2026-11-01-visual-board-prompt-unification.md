# Visual Board Prompt Unification Implementation Plan

> **For agentic workers:** Implement the user's authorized optimization in this chat using the existing collaboration tools. Preserve all earlier repairs and unrelated edits.

**Goal:** Give setting-image creation one main editable task, with optional supplemental instructions, so refinement does not produce a second complete copy.

**Architecture:** Keep the serialized `设定图固定要求` managed section and its source/merge metadata. Present it as the main `设定图内容`, expanded by default. Refinement consumes its content plus authored supplements and returns one reviewed main section; other managed style/reference/parameter sections remain unchanged. Source-backed content is sufficient to generate without boilerplate body text.

**Tech Stack:** Shared TypeScript, React/Mantine/Tiptap, Fastify, node:test.

**Spec:** The preceding source-based analysis and the user's request for professional optimization in this chat.

## Global Constraints

- No semantic-similarity deletion of saved drafts. Existing text is retained until a user applies a reviewed refinement result.
- Preserve source snapshots, block identities, pending decisions, deletion/recovery, reference identity, undo/redo and explicit image connection semantics.
- Keep ordinary shot/image/video refinement behavior compatible. Do not rewrite saved project/profile facts from local refinement.
- Use mocks and isolated fixtures only; no real model/media generation, business data writes, commit, push or deployment.

## Review Focus

- A primary-only document must support generation, preview, refinement, saved reload and batch preparation.
- Refinement must produce one main creative section while preserving other managed sections exactly; additional instructions are incorporated once.
- Missing/deleted primary sections must not be silently recreated from saved project facts.
- Same-name ambiguity, source updates, custom edits and history must not transfer metadata or revive deleted content.
- Removing all creative content still blocks generation even when style/parameter sections remain.

### Task 1: Shared creative-content contract

**Files:** new `packages/shared/src/visuals/visual-board-document.ts`; focused backend/shared tests.

**Interfaces:** `visualBoardPromptParts(document)` returns primary section bodies, supplemental body and other bounded sections; `hasVisualBoardPromptContent(document)` checks only creative content; `replaceVisualBoardPromptContent(document, content)` updates a single existing primary and incorporates the supplemental body, or preserves the body target when the primary is absent. Multiple primaries require an explicit decision.

- [x] Add the pure helpers and tests for primary-only, deleted/missing primary, other-section preservation, duplicate primary ambiguity and authored supplements.
- [x] Preserve deliberately absent primary sections in legacy complete drafts that have no section metadata, while retaining explicit source recovery.

### Task 2: Refinement and backend generation

**Files:** `backend/src/modules/skills/skill-routes.ts`, `backend/src/modules/visuals/visual-profiles.ts`, focused tests.

- [x] Refine the current main content and supplements together into one main section, preserving other bounded sections and current-document authority.
- [x] Permit primary-only documents and default profile boards without dummy body prose; retain validation for truly empty creative content.
- [x] Verify image/profile references, parameter checks, context version checks and local-only application.

### Task 3: Editor and refinement presentation

**Files:** `CanvasPromptEditor.tsx`, presentation/CSS, `PromptSkillAction.tsx`, focused UI tests.

- [x] Add opt-in setting-image presentation: main section titled `设定图内容` and expanded, body labeled as optional supplement, remaining requirements secondary.
- [x] Enable refinement from a main section with empty body, show one editable complete candidate, retain source metadata and existing keyboard/history behavior.
- [x] Keep an emptied candidate mounted for undo; prevent implicit fallback to the original draft. Preserve active identities independently from deleted same-name source sections through refinement, editor synchronization and reload.

### Task 4: Canvas and batch integration

**Files:** `ProjectCanvas.tsx`, `canvas-reference-generation.ts`, compiler/default handling, integration tests, docs.

- [x] Use effective creative content for generate/refine gates and stop adding dummy profile body text to new drafts.
- [x] Align selected-node and batch preview/submission paths, saved reload and deleted-primary behavior.
- [x] Build shared before consumers, run focused suites and required checks/builds, independently review, then verify the UI in an isolated browser fixture and remove it.

**Verification:** Shared helpers 13/13; backend prompt/board suites 72/72 and final authority guards 3/3; final web regression suites 202/202. Shared/backend/web builds, architecture/UI guards and diff checks passed. Browser TaskSpace 15 verified native selection/deletion/undo, primary-only refinement, empty-candidate undo, explicit application and saved reopen against an isolated fixture; the space was finished and both fixture files removed. Model responses and media submission were mocked; no paid model/media generation or business-data writes were performed. See `docs/superpowers/acceptance/2026-11-01-visual-board-prompt-unification.md`.
