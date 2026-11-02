# Prompt Requirements Repair Implementation Plan

> **For agentic workers:** Implement the authorized repair in this session using the available collaboration tools. Preserve unrelated working-tree edits.

**Goal:** Make displayed generation requirements, source updates, request parameters and resulting style metadata agree.

**Architecture:** Preserve the existing editable prompt document and exact serialization. Add reliable effective-style provenance, conservative source reconciliation, resolution normalization and source-aware presentation. Keep actual request parameters authoritative, with explicit conflict handling.

**Tech Stack:** TypeScript, React/Mantine/Tiptap, Fastify, SQLite, node:test.

**Spec:** The implementation review and user's instruction to repair its findings in this chat.

## Global Constraints

- Preserve current uncommitted work, including edits in shared integration files.
- No external model calls or paid media generation. Use temporary databases for backend tests.
- No commit, push, deployment or live business-data writes are required.
- Preserve edited/deleted prompt blocks, reference identities, copying and undo behavior.

## Review Focus

- A custom or removed style must not receive inherited-style approval or bypass reference warnings.
- Video 4K, 2160p and 3840x2160 are equivalent; differing resolutions remain conflicts.
- Reordered duplicate blocks must never transfer edits to another object without a decision.
- Repeated source updates during a pending conflict must not misclassify automatically merged text as creator text.
- Source labels, summaries, comparison and recovery must remain accessible without changing sent text.

### Task 1: Effective style provenance

**Files:** shared visual-style contract/API types; backend project-visual-style, visual-profiles and reference registration; corresponding backend tests.

**Interfaces:** Persist server-computed effective style origin and fingerprint separately from the project version snapshot. Existing clients remain compatible; never trust a client-supplied effective-style claim.

- [x] Add regressions for customized and removed style documents through preview, enqueue, completion and reference checks.
- [x] Record actual style provenance and prevent automatic project-style approval for overrides; retain explicit human confirmation.
- [x] Run focused backend tests and align the stale follow-mode assertion with current behavior.

### Task 2: Document reconciliation and parameter equivalence

**Files:** shared prompt-section-document and prompt-parameter-conflicts; backend focused unit tests.

**Interfaces:** Keep existing parse/reconcile/resolve signatures and version-1 document compatibility. Optional metadata may be added with validation and serialization unaffected.

- [x] Reproduce resolution aliases, duplicate-source reordering and multiple updates during pending conflict.
- [x] Normalize video clarity and preserve explicit source ambiguity; track the merge baseline independently of the accepted source where needed.
- [x] Verify edit/deletion/source metadata survive parse, save and resolution.

### Task 3: Source-aware requirements presentation

**Files:** CanvasPromptEditor, CanvasPromptDocumentStatus, prompt presentation/CSS and focused UI tests; add a small presentation helper where useful.

**Interfaces:** Add an optional source-resolution callback to the editor, preserving existing callers. Derive labels from the 11 known block types; leave serialized names and order intact.

- [x] Show responsibility, actual source, compact content summary and inherited/custom/pending state.
- [x] Expose comparison and pending resolution beside the block; show line differences and a discoverable removed-block recovery action.
- [x] Explain that the bottom generation controls determine request parameters; retain conflict checks for editable parameter text.
- [x] Verify folding, copying, deletion, recovery, references, undo and read-only behavior.

### Task 4: Integration and validation

**Files:** ProjectCanvas and focused integration tests/documentation.

- [x] Integrate inline source actions and reduce repeated prompt compilation/reconciliation during unrelated renders using stable dependencies.
- [x] Build shared before consumer tests; run relevant tests, architecture/UI checks and both builds.
- [x] Review the final diff against starting work and record results and any remaining limits.

## Validation record

- Shared/persistence regression suites: 22/22 passed.
- Backend style, reference and prompt generation suites: 85/85 passed before final reference UI review.
- Editor/source/difference/recovery UI suites: 48/48 passed.
- Compiler, composition, style warning and canvas integration suites: 104/104 passed.
- Shared build, backend build, web build and architecture/UI checks passed.
- Browser verification used the real editor/status components in a temporary in-memory fixture: source summaries, line differences, preserving a custom edit, removing a block and restoring its source all passed. TaskSpace 12 was finished and fixture files removed. No business API writes or model generation were used.
- Final review fixes: independent reference candidates now allow per-image style confirmation/reconfirmation; reviewed old boards remain reviewed after replacement, including locked bindings and historical candidates. Automatic/bulk confirmation also validates each candidate's own immutable source fields.
- Final affected backend suites: 14/14 passed; backend build passed. Public legacy-job metadata is derived only in responses, with unchanged stored request verified.
- Final independent-reference UI and style-warning suites: 19/19 passed; web build passed (existing large-bundle advisory only).
- Final architecture/UI checks and `git diff --check` passed. The reviewer found no additional issues in provenance derivation, audit owner scope, base version checks or response metadata.

## Scope and remaining limits

- Parameter conflict checks cover supported structured aliases; they do not infer arbitrary natural-language contradictions.
- Style provenance describes actual sent managed style text and the project baseline. It does not certify generated pixels match that style.
- Duplicate sources without reliable identity anchors retain existing content for an explicit decision; this is not a domain-wide source-key migration.
- Unrelated working-tree edits are preserved. No commit, push, deployment or real media generation is part of this repair.

## Follow-up: Standard selection editing

**Goal:** Whole-prompt and cross-section selections support delete, typing, paste and cut while preserving actual image inputs and undo history.

**Files:** `CanvasPromptEditor.tsx` owns transaction classification and reference callbacks; `ProjectCanvas.tsx`, section details and document status ignore conflicts on intentionally deleted blocks; focused editor/status tests verify behavior.

- [x] Replace the old whole-section deletion prohibition with content-edit handling. Preserve empty-caret boundary protection and targeted reference actions.
- [x] Treat whole-document replacement and section removal as text changes, including history replay; preserve actual image connections and all removed source snapshots.
- [x] Verify Backspace/Delete, typing, plain/HTML paste and actual cut; one undo restores original IDs, references and source metadata, and redo restores the edited result.
- [x] Verify whole-prompt edits without managed blocks, partial selection and ordinary optional-chip deletion remain consistent.
- [x] Deleted blocks keep recoverable source metadata but do not leave hidden conflicts that block new prompt generation.
- [x] Run editor/status/integration regressions, web build, architecture/UI checks and browser keyboard verification against an isolated fixture; clean temporary files.

### Follow-up validation

- Editor suite: 59/59 passed, including actual delete key and cut events, whole/partial selections, plain/HTML paste, same-text/same-name paste identities, new input materialization and explicit single-chip menu history.
- Deleted pending-source helper/status/board submission suites: 16/16 passed. Full video-reference canvas integration: 85/85 passed.
- After final editor changes, six focused canvas integrations passed, including keyboard clear, saved empty profile prompt reload and unchanged actual image connections.
- Web production build, architecture/UI checks and final whitespace validation passed. Existing large-bundle advisory remains.
- Independent review reproduced and verified the fixes for single-chip action history and adding a new image through whole-prompt paste; no actionable issue remained.
- Browser TaskSpace 13 used real native shortcuts against an isolated in-memory fixture. All-selection Backspace/Delete, typing replacement, native cut/paste, plain-text replacement and separate undo/redo passed; folded text and recoverable source metadata stayed intact, reference callbacks were zero and there were no business API requests.
- TaskSpace 13 was finished once and both temporary browser fixture files were removed. Existing development servers were preserved.
