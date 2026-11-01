# Basic Final Cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver a usable independent basic editing workbench, verified by an editable 90-second 傩王 trailer and actual app export.

**Architecture:** An independent editing-cut document references existing project assets. Its ordered visual clips, narration, music, mix and captions never mutate storyboard or global audio settings. Saved revisions become immutable export job snapshots; the existing renderer and browser player gain optional captions.

**Tech Stack:** React 19, Mantine 9, Fastify, SQLite, TypeScript shared contracts, existing FFmpeg.

**Spec:** [Basic final cut](../specs/2026-11-01-basic-final-cut.md)

## Global Constraints

- React 19 / Mantine 9 / Fastify / SQLite / existing FFmpeg; no new dependencies.
- Preserve unrelated working-tree edits, original media, storyboard, speech selections and project mix.
- No paid generation, commit or push.
- Explicit revision save; independent cuts and immutable export snapshots.

## Review Focus

- A repeated asset must have independently editable clip IDs and trims.
- A save response from an old selection must not replace the active cut.
- Source assets with missing files, wrong project, or invalid media durations cannot enter exports.
- Chinese captions and text containing punctuation must render safely and legibly.
- Playback, export and download must correspond to the selected saved cut and revision.

### Task 1: Independent document and export

**Files:** `packages/shared/src/media/editing-cut.ts`; `backend/src/modules/final-cut/editing-cuts.ts`; minimal `backend/src/app.ts` and `backend/src/infrastructure/database/db.ts` registration; `backend/src/infrastructure/media/render.ts`; `backend/test/editing-cuts.test.ts`.

**Interfaces:** `EditingCut`, `EditingCutInput`, `EditingCutClip`, `EditingCutSpeech`, `EditingCutCaption`. GET/POST `/api/projects/:id/editing-cuts`; PUT `/api/projects/:id/editing-cuts/:cutId` with revision; POST `/api/projects/:id/editing-cuts/:cutId/export` with revision. Lists return `{cuts}`, saves return a cut, exports return a regular Job. Renderer accepts optional captions as its last argument.

- [x] Add shared contracts and independent SQLite storage with revision CAS.
- [x] Validate ownership, media kinds, numeric ranges and export media duration; keep draft edits possible before tracks are finished.
- [x] Save `editing_cut_id`, `editing_cut_revision`, name, all clip/audio/mix/caption values into queued export request.
- [x] Burn optional captions without changing legacy exports.
- [x] Run backend tests for isolation, repeated assets, CAS, snapshot immutability and invalid media; build backend.

### Task 2: Basic editor and preview

**Files:** `web/src/features/final-cut/BasicFinalCutStudio.tsx` and focused helpers/panels/CSS; `TimelinePreview.tsx`; `web/test/basic-final-cut*.test.*`.

**Interfaces:** Props `{detail:ProjectDetail,sourceCanvasId?:string|null,onRefresh:()=>Promise<unknown>,onOpenSpeech:(lineId?:string)=>void,onNotice:(message:string)=>void}`. Uses Task 1 endpoints and shared contracts. Temporary in-memory shot adapters are only for the player.

- [x] Implement document loading, create, save, conflict and unsaved-change handling, with stale-response protection.
- [x] Add asset import, repeated visual clips, reorder/remove, trims and per-clip source gain.
- [x] Add narration selection/replacement, timing and gain; music selection/mix and captions.
- [x] Show continuous preview with captions, export progress/error and per-cut downloads.
- [x] Test duplicate trims, selection races, conflict protection, audio replacement and caption preview; build web.

### Task 3: Integration and real acceptance

**Files:** minimal `web/src/app/App.tsx`; product guide/acceptance evidence under this spec and the existing trailer production directory.

- [x] Make basic editing the default workbench with a clear legacy storyboard mode; preserve original entry points.
- [x] Run architecture/UI checks and targeted legacy regression tests.
- [x] In the running app, build a new 90-second cut from the six source videos, six narration assets, original music and title image; use app export.
- [x] Verify narration replacement is scoped, Chinese subtitles render, output decodes and lasts 90 seconds, and original project data remains unchanged.

## Acceptance evidence

- Shared, backend and web builds passed; architecture and UI guards passed.
- Backend editing/export tests include independent revisions, ownership, true decoded durations, arbitrary short clip timing, subtitle placement, immutable snapshot and stereo preservation.
- Frontend basic editor: 11 tests passed; existing final-cut workspace, partial preview and speech preview: 34 passed.
- Real UI replaced all six narration clips with the user-selected newer candidates, saved revision 3, played synchronized subtitles/audio and submitted export.
- Final app export job: `f9dd8397c0204d15b93f785003c7ffcc`; asset: `5c4d7dd414704ffaa99f7a972a8e4c57`.
- Actual output: 90.00 seconds, 1280×720, 24fps, AAC 48kHz stereo; full decoding passed.
- Current baseline preservation: all 19 existing shots, 85 existing assets, all 3 canvases, script, speech selections, project audio, timeline, reviews, tasks and visual bindings unchanged.
- Evidence: `production/2026-11-01-nuowang-trailer/reference/basic-editor-*.json` and `basic-editor-workbench.png`.
