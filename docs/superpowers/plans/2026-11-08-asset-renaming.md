# Asset Renaming Implementation Plan

> **For agentic workers:** Execute the two tasks below in this session, with backend implementation delegated and a final independent review.

**Goal:** Let users give assets a persistent name from the asset library.

**Architecture:** Store a nullable `display_name` separately from asset filenames and references. Use the existing presentation helper to prefer a custom name and expose a rename dialog from card menus and asset previews.

**Tech Stack:** React, Mantine, TypeScript, Fastify, SQLite, node:test.

**Spec:** User report and screenshot in this chat: asset-library materials cannot be named.

## Global Constraints

- Preserve all existing unrelated working-tree changes.
- Support generated, uploaded and exported materials, including old assets.
- Accept trimmed names of 1–120 characters; reject control characters.
- Keep media storage and existing asset references intact.
- Use the existing UI components and Chinese labels.

## Review Focus

- Generated asset names must take precedence over automatically inferred titles.
- Whitespace-only names and names longer than 120 characters must not save.
- A failed save must preserve the draft and allow retry.
- Switching projects while editing must not update another project's state.
- Renaming must survive reloading and remain searchable.

### Task 1: Persist custom asset names

**Files:** `backend/src/infrastructure/database/db.ts`, `backend/src/app.ts`, `packages/shared/src/api/contracts.ts`, `backend/test/asset-naming.test.ts`.

**Interfaces:** Add `Asset.display_name?: string | null`. `PATCH /api/assets/:id` accepts `{ display_name: string }` and returns a public `Asset`.

- [x] Add API regression tests for persistence, trimmed Chinese names, invalid names, missing/deleted assets, and unchanged file references.
- [x] Add an idempotent nullable SQLite column migration, shared/backend types and the validated update route.
- [x] Run backend naming and existing asset-related regressions (15 passed).

### Task 2: Rename from the library

**Files:** `web/src/features/assets/AssetRenameDialog.tsx`, `web/src/features/assets/asset-presentation.ts`, `web/src/features/assets/asset-library.ts`, `web/src/app/App.tsx`, `web/test/asset-renaming.test.tsx`, `web/test/asset-library-renaming.test.tsx`, `web/test/asset-presentation.test.ts`, `web/test/asset-library.test.ts`.

**Interfaces:** A dialog receives the asset, its currently displayed name, an async save callback and a close callback. A successful PATCH replaces the asset in the current project detail and preview. The presentation helper and search use `display_name`.

- [x] Test custom-title precedence and name searching; test dialog validation, saving, cancellation, pending state and retry after failure.
- [x] Add “重命名” to card menus and previews, with a focused name field and Save/Cancel actions.
- [x] Keep the draft open on error and guard updates against project changes.
- [x] Run targeted web tests, project checks and builds; verify the user interaction in the browser if available.
- [x] Review the resulting diff independently and repair actionable findings.

**Validation:** Backend asset regressions 15 passed; web naming/presentation/library/download/project regressions 26 passed. Shared, backend and frontend builds and architecture/UI guards passed. Browser verification used a disposable local project: renamed an uploaded PNG, reloaded, found it by the Chinese name, and checked cancelling from its preview. Independent review findings were fixed and pinned by App integration tests: an older in-flight poll cannot overwrite the saved name, and Escape dismisses only the rename dialog above an open preview.
