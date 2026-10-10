# Director execution UX

## Goal
Make script dialogue execution understandable: task, current work, actual sources and rules, result/save state, and useful next actions. Retain complete technical records and existing draft workflow.

## Phases
- [x] Audit existing UI, events and persistence.
- [x] Implement readable activity projection and semantic event targets.
- [x] Integrate per-message task/outcome state, draft actions and safe retry/recovery.
- [x] Redesign task progress UI using existing dark theme.
- [x] Verify live updates/history/actions, visual layout and builds.

## Decisions
No paid model requests or user project changes. No automatic retry of mutation functions; use draft recovery when an operation may have persisted. No fabricated reasoning, progress percentage or future steps. Default display is concise; JSON, IDs, rounds and start time remain under technical details. Preserve prior dirty changes. No subagents requested.

## Errors
Initial file inventory referenced absent .agents/.codex directories; repository has no applicable AGENTS.md.
Delete/add replacement of the same file in one patch was rejected; replaced the files through quoted heredocs.
Initial frontend build exposed an artifact-card type mismatch; source navigation now resolves real saved IDs before using artifact keys.
Updated old trace assertions for collapsed grouped steps; corrected a test expectation and supplied the actual explicit stage context in the question fixture.
Sandbox blocked the temporary loopback Vite listener; the approved local-only retry succeeded. A browser action after hot reload used stale page state; inspected and reloaded the isolated page before continuing.
