# Incremental Script Documents Implementation Plan

> **For agentic workers:** Implement in this session with separate backend and frontend ownership, followed by independent review. The user has authorized the incremental-save behavior.

**Goal:** Show each completed script column as a persisted draft before the entire generation task finishes.

**Architecture:** Expose validated complete documents from existing generation checkpoints as a separate project detail field. Fall back to the pending creation draft after the checkpoint is cleared. The canvas lists all columns in each stage and receives a deduplicated refresh when a column completes.

**Tech Stack:** TypeScript, Fastify, SQLite, React, Mantine, node:test.

**Spec:** `docs/superpowers/specs/2026-11-09-incremental-script-documents.md`

## Global Constraints

- Preserve unrelated local edits, formal documents, model choices and existing generation checkpoints.
- Only complete, schema-valid columns are displayed as saved drafts; partial JSON and semantic blocks do not become complete columns.
- Keep formal confirmation and downstream production behavior unchanged.
- Use temporary databases and mocked model transport only.

## Review Focus

- A later failed column must leave earlier persisted drafts readable after reload.
- Final draft creation clears generation checkpoints without hiding pending documents.
- Confirming or discarding a draft removes its pending display.
- Regenerated drafts must not overwrite or hide access to accepted originals.
- Duplicate SSE activity snapshots must not cause repeated refresh requests.

---

### Task 1: Read persisted document progress

**Files:** `packages/shared/src/api/contracts.ts`, `backend/src/modules/script/script-generation-progress.ts`, `backend/src/app.ts`, `backend/test/script-generation-progress.test.ts`, `backend/test/script-work-contract-integration.test.ts`.

**Interfaces:** Export `ScriptGenerationProgress` with `updated_at` and `documents` (artifact_type, title, content, episode_number). Add optional `ProjectDetail.script_generation_progress`. Export `scriptGenerationProgress(projectId: string): ScriptGenerationProgress | null`.

- [x] Add tests for complete checkpoint columns, malformed/incomplete exclusion, persisted reread, pending draft transition, confirmation/discard, and unchanged formal data.
- [x] Implement projection and expose it in GET project detail without changing projectScript().
- [x] Run backend focused tests and TypeScript validation.

### Task 2: Display and refresh columns

**Files:** `web/src/features/canvas/CanvasScriptDocuments.tsx`, `web/src/features/canvas/ProjectCanvas.tsx`, `web/src/features/canvas/project-canvas.css`, `web/src/features/script/ScriptDirectorPanel.tsx`, focused web tests.

**Interfaces:** `CanvasScriptDocuments` receives current section, accepted artifacts/legacy outline, progress, and existing document/director callbacks. Each draft is labeled and rendered as readable text; accepted originals remain available.

- [x] Add rendering tests for every stage, first-column completion, partial/failure state, regenerated draft vs original, and completion/discard refresh.
- [x] Replace the single-artifact preview with a section list and persist current reading via stable keys.
- [x] Refresh once per succeeded document activity; coalesce repeated snapshots and refresh when final results clear checkpoints.
- [x] Run focused web tests, build and architecture/UI checks.

### Task 3: Verify and review

- [x] Have an independent agent inspect data boundaries, lifecycle, error recovery and test evidence.
- [x] Repair confirmed issues and rerun only affected checks.
- [x] Record tested behavior and any runtime limits; do not commit unrelated work or call real models.
