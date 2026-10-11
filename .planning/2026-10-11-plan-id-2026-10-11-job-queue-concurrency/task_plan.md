# 任务队列并行调度
PLAN_ID=2026-10-11-plan-id-2026-10-11-job-queue-concurrency

## Goal
Allow bounded concurrent generation with a persistent user-adjustable limit and robust queue lifecycle.

## Phases
- [x] Audit current worker, result writes, restart and UI contracts.
- [x] Implement atomic claiming and configurable bounded dispatch; retain one export at a time.
- [x] Add task-page concurrency control and queue counts.
- [x] Validate actual overlapping jobs, limits, failures, stop behavior, API persistence and UI.

## Constraints
Preserve unrelated uncommitted work. No paid live generation, real project writes, commit or push. Check live running jobs before changing watched backend files. Preserve speech/image restart safeguards.

## Decisions
Default concurrency 3, adjustable 1–10 across projects; lowering the limit lets current jobs finish. Export remains single-file/lane concurrent because it uses local FFmpeg resources. Preserve existing task states and immutable requests.

## Errors
- Initial local curl from sandbox was blocked; read-only local API checks succeed with network escalation.
- init-session treats --plan-id as title text; use its returned exact PLAN_ID rather than guessing argument support.
