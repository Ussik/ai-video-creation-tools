# Editor Generation Drafts Implementation Plan

> **For agentic workers:** Implement and review the display projection and regression checks in the current authorized task.

**Goal:** Show the same persisted pending screenplay documents in the full editor that are already readable on the canvas.

**Architecture:** Keep generation progress separate from editable and saved script state. Render pending documents as read-only versions within their existing sections and include them in navigation, completeness, and search.

**Tech Stack:** React, TypeScript, Tiptap, Node test runner, JSDOM.

**Spec:** `docs/superpowers/specs/2026-11-09-incremental-script-documents.md`, extended by the user's request that the full editor display the same generated documents as the canvas.

## Global Constraints

- Pending documents retain the label “已保存草稿 · 待确认”.
- Reading, polling, and searching must not adopt drafts or modify business data.
- Pending text must not enter `draft`, undo history, or the ordinary `/script/commit` payload.
- Preserve existing confirmed documents and local edits while generation progress changes.

## Review Focus

- Empty accepted script with completed pending columns shows their text instead of “未生成”.
- A new candidate and an existing confirmed original are both available.
- Polling updates and removal of progress preserve local manual edits.
- Accepting identical text leaves one document rather than two copies.
- Pending episode scripts participate in navigation and search without producing editable confirmed content.

### Task 1: Display and validate pending documents

**Files:**
- Modify: `web/src/features/script/ScriptEditor.tsx` — independent pending projection, section rendering, navigation, counts and search.
- Modify: `web/src/features/script/script-editor.css` — draft status and version spacing.
- Test: `web/test/script-generation.test.tsx` — behavior and save isolation.

**Interfaces:**
- Consumes `ProjectDetail.script_generation_progress.documents` and the existing accepted script.
- Produces read-only document surfaces in existing `data-script-section` containers; the save contract remains the editable accepted script.

- [x] Add regression tests for the five review cases, including save-payload isolation.
- [x] Confirm new display assertions fail before the implementation.
- [x] Add a pending projection without modifying `fromDetail()` or save serialization.
- [x] Render pending versions, include them in counts/navigation/search, and clear formatting focus for read-only documents.
- [x] Run editor, search, and canvas document tests, then frontend build.
- [x] Verify the real project's canvas draft also appears in its full editor without writing project data.

Validation: 16 editor-generation tests and 20 search/canvas-document tests passed; frontend build and UI guard passed. The real project displayed five pending columns in the editor, with all 239 canvas paragraphs present, read-only candidates, and a disabled ordinary Save button. Browser evidence: `/private/tmp/script-editor-generation-drafts.png`.

No commit is required for this fix in the existing working tree.
