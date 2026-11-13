# Generation storage quota recovery implementation plan

> **For agentic workers:** Execute the checked tasks in this session using the native implementation and independent review available here.

**Goal:** Allow image/video generation when localStorage is full without losing existing submission identities or unsynced drafts.

**Architecture:** Move the durable generation submission ledger to IndexedDB, migrate validated legacy records only when writing under the existing submission lock, and await transaction completion before sending requests. Keep the existing Web Lock names and read-only recovery behavior; notify other tabs after committed writes.

**Tech Stack:** TypeScript, React, IndexedDB, Web Locks, node:test, jsdom.

**Spec:** User-reported localStorage quota error in generation and request to resolve it; the safety constraints below define this focused fix.

## Global Constraints

- Preserve unrelated working-tree changes and unsynced local content.
- Preserve original submission IDs, operation keys, payloads and unknown acceptance state.
- No generation POST before durable storage commits; no silent fallback after IndexedDB failure.
- Retain localStorage fallback only when IndexedDB is unavailable, with the existing fail-closed behavior.
- Do not call paid models during verification.

## Review Focus

- Legacy pending records, malformed records and concurrent older tabs must never be discarded or replaced by a fresh intent.
- Request success followed by transaction abort must prevent submission.
- Full localStorage must not prevent a healthy IndexedDB submission.
- Cross-tab notifications must only recover already accepted jobs, never submit missing candidates.
- Async reads must not continue against a different selected node or canvas.

### Task 1: Durable storage adapter and migration

**Files:** Create `web/src/features/canvas/canvas-generation-storage.ts`, `web/test/canvas-generation-storage.test.ts`; update web test dependencies if needed.

**Interfaces:** `CanvasGenerationStorage` accepts synchronous or asynchronous getItem/setItem; optional `migrateItem` runs after ledger validation. `canvasGenerationStorage()` selects the browser backend. `subscribeCanvasGenerationStorage(listener)` handles committed cross-tab changes.

- [x] Test full localStorage, validated legacy migration, conflicts, aborted transactions and unavailable storage.
- [x] Implement IndexedDB transactions that resolve only after completion; preserve legacy on errors.
- [x] Run storage unit tests.

### Task 2: Await storage throughout generation and recovery

**Files:** Modify `web/src/features/canvas/canvas-generation-submission.ts`, `web/src/features/canvas/ProjectCanvas.tsx`; adapt `web/test/canvas-generation-submission.test.ts`, `web/test/canvas-video-reference-integration.test.tsx`, `web/test/canvas-visual-setting-template-integration.test.tsx`.

**Interfaces:** read/create/persist return Promises; existing operation keys and Web Lock names stay identical.

- [x] Await reads and writes, validate migrated records before migration, and recheck canvas state after async boundaries.
- [x] Subscribe recovery to IndexedDB notifications and correct the failed-recovery notice.
- [x] Verify normal generation, unknown/partial acceptance, reload recovery and blocked durability.

### Task 3: Verify and review

- [x] Run relevant unit/integration tests, architecture/UI checks and the web production build.
- [x] Independently review migration and duplicate-submit guarantees; fix actionable findings.
- [x] Report verified behavior and limits, including whether the user's live browser was exercised.


## Validation evidence

- Focused storage, ledger and setting-generation integration: 41/41 passed; complete canvas video-reference integration: 106/106 passed (147 total).
- Architecture/UI checks and web production build passed; existing bundle-size warning remains.
- Real Chromium test on isolated `http://localhost:5199`: filled localStorage to its quota (5,242,832 padding characters), committed the in-flight key before exactly one simulated generation POST, preserved an unsynced draft, and recovered the accepted job after reload.
- User project storage was not cleared or modified. The isolated browser fixture and synthetic data are removed after verification; no real model was called.
- Independent migration review found and fixed deletion of the legacy key: a compact version-2 marker now makes older readers stop instead of creating a fresh operation. Reads remain mutation-free and migrations occur in the existing write lock.

## Release note

Reload all Studio tabs before using the updated generation flow. A new key in a completely full legacy store may be unable to hold its compatibility marker; if storage is later freed, an unrefreshed older client could start using its old writer. Completed and unknown submission records remain durable, and IndexedDB failures stop new requests rather than switching to an empty ledger.
