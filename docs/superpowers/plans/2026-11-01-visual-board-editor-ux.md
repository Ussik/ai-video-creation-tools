# Visual Board Editor UX Implementation Plan

> **For agentic workers:** Implement this user-authorized optimization in the current chat. Preserve earlier fixes and unrelated working-tree edits; use the available collaboration tools for independent work and review.

**Goal:** Put the setting-image task first, make optional supplements and auxiliary requirements quieter, and provide one parameter configuration surface.

**Architecture:** Keep one Tiptap document with stable managed-section identities and source snapshots. Setting-image presentation orders the primary task, optional authored supplements, then auxiliary sections in the actual document/clipboard order; opening the editor never writes a draft. Reuse the existing generation-parameter popover rather than duplicating controls. Source operations remain available through explicit menus and the provenance disclosure.

**Tech Stack:** React, Mantine, Tiptap, existing CSS and node:test component harnesses.

**Spec:** User's 2026-11-01 screenshot and the preceding six-point analysis, followed by “优化一下”.

## Global Constraints

- Preserve full selection, deletion, cut/paste, undo/redo, reference connections, pending source decisions and removed-section recovery.
- Do not drop, paraphrase or semantically deduplicate authored content. Display order, keyboard order and copy order agree.
- Keep generic image/video editors compatible and preserve the current serialization markers.
- No new dependency, business-data writes, real model/media calls, commits, pushes or deployment.

## Review Focus

- Legacy prose before/between managed blocks retains every meaningful instruction, reference, identity and source snapshot after main-first presentation and editing.
- A source update or prop echo cannot continually reorder the local caret or destroy undo history; opening alone produces no save.
- Empty supplements are compact but remain discoverable and can accept multiline text and @ references.
- Parameter shortcuts open the same existing popover; advanced custom text and conflict checks still work.
- Menus and local focus cues remain usable with keyboard, small screens and read-only/disabled states.

### Task 1: Main-first document and presentation

**Files:** `canvas-prompt-composition.ts`, `CanvasPromptEditor.tsx` document adapters, `canvas-prompt-presentation.ts`, focused composition/editor tests.

- [x] Add a pure idempotent main-first presentation helper preserving authored prose, metadata and tombstones; leave ambiguous multiple-primary documents intact.
- [x] Render a compact supplemental entry after the primary in the same editor, without writing on open or losing clipboard/history behavior.
- [x] Verify multiline supplements, legacy ordering, empty/deleted primary, source updates and whole-document editing.

### Task 2: Sections and sources

**Files:** `CanvasPromptEditor.tsx` node views, `canvas-prompt-editor.css`, `CanvasPromptDocumentStatus.tsx` and CSS/tests.

- [x] Keep main content readable and initially expanded; use quiet auxiliary rows and local focus cues.
- [x] Put infrequent difference/removal actions in accessible menus; show custom/pending states where useful and preserve inline source decisions.
- [x] Consolidate provenance details in “来源与修改记录”, keeping removed-section recovery and pending choices accessible.

### Task 3: One parameter surface and integration

**Files:** `CanvasGenerationControls.tsx`, `ProjectCanvas.tsx`, editor props, integration tests, docs.

- [x] Add controlled opening to the existing parameter popover; setting-image parameter rows display a concise summary and open that popover.
- [x] Keep advanced text editing explicit and all parameter conflict checks intact.
- [x] Run focused regressions, required guards/builds and independent review; verify real components in an isolated browser fixture and remove it.

## Completion

Completed 2026-11-01. Acceptance: `docs/superpowers/acceptance/2026-11-01-visual-board-editor-ux.md`. Editor 70/70, real canvas 90/90, auxiliary suites 72/72, architecture/UI guards, Web build and diff checks passed. Browser TaskSpace 16 finished; isolated fixtures removed.
