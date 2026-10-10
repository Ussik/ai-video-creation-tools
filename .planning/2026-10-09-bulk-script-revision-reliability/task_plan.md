# Bulk Script Revision Reliability
PLAN_ID: 2026-10-09-bulk-script-revision-reliability

## Goal
Reliable delegated completion across documents: persistent scope/decisions/progress, unified draft, versioned targeting, structured diagnostics, bounded repair and honest completion.

## Constraints
Preserve previous dirty changes. No commit/push. No real model charges or real project writes in verification. Exact matching and source version/scope checks remain mandatory. Proposed decisions stay in draft until saved. No subagents.

## Phases
1. [complete] Inspect contracts and design.
2. [complete] Implement backend batching, accumulation, repair and verification.
3. [complete] Frontend progress, resume and before/after previews.
4. [complete] Isolated tests, builds and documentation.

## Errors
Initial apply_patch rejected delete/add of same target. Corrected using direct planning-file writes.

Additional errors: frontend type import traversed node:crypto; separated runtime-free public types. New tests initially omitted required mode and spread read-only reference fields into strict write schema; corrected fixtures. Two apply_patch context/order mismatches were corrected without changes being lost.

## Final validation
Backend full suite: 250/250; after final task-answer compatibility adjustment, all 67 document-tool cases pass. Frontend full suite: 216/216; final progress/dirty presentation covered by 32 relevant cases. Both final builds pass. git diff --check passes. Tests used temporary databases and mocked providers, without paid model calls or user project writes.
