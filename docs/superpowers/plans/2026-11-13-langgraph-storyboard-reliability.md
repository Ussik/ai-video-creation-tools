# LangGraph Storyboard Reliability Implementation Plan

Workers use the established task ownership and existing repository verification commands. Completed work is recorded with checkboxes.

**Goal:** Make failed storyboard generation recover at small validated units under a real LangGraph workflow and explicit durable budgets.

**Architecture:** LangGraph replaces the workflow orchestration only. Existing task/control.steps persistence remains authoritative; provider adapters, strict schemas, identity/commit guards and Langfuse hooks remain in place. Structural correction operates only on fixed subtrees and never weakens final validation.

**Tech Stack:** TypeScript, Fastify, SQLite, Zod4, LangGraph1.7.4/core1.3.4, existing providers and Langfuse.

**Spec:** docs/superpowers/specs/2026-11-13-langgraph-storyboard-reliability.md

## Global Constraints

- Same selected model/provider/reasoning settings; no automatic replacement.
- No second persistence authority, automatic graph retry, LangSmith export or unbounded loop.
- Only complete validated units enter checkpoints; original strict review/commit gate remains mandatory.
- Existing two format rounds and three actual attempts per model step remain.
- Real acceptance uses isolated data/service; formal projects/services remain untouched.

## Review Focus

- Restart after accepted unit must reuse it without another model charge.
- Partial/invalid JSON must not become a saveable candidate or guessed repair.
- Structured patch cannot modify identity, audio or text outside fixed target paths.
- Background admission/resume must not inherit HTTP token ledgers or abort signals.
- Budget exhaustion and cancellation must stop before any further dispatch and preserve validated work.

---

### Task 1: Graph orchestration and dependency

**Files:** backend/package.json, package-lock.json, backend/src/modules/storyboard/storyboard-planning-workflow.ts; backend/test/storyboard-planning-graph.test.ts.

**Interfaces:** Preserve runStoryboardPlanningWorkflow(control, options) and all options methods. Use StateGraph/Annotation fixed nodes; invoke with signal, explicit recursionLimit and local-only tracing context.

- [x] Add graph branch/resume/review/repair/cancel tests around the existing control interface.
- [x] Implement actual LangGraph nodes and conditional edges, keeping SQLite checkpoints and no retries.
- [x] Run graph and durable task tests; review for replay and automatic tracing.

### Task 2: Structural repair at fixed paths

**Files:** backend/src/modules/generation/model-output.ts, new model-output-repair.ts; model-output repair tests.

**Interfaces:** Add optional structuralRepair:boolean to generateStructuredOutput options. Pure helper derives <=8 disjoint subtrees from Zod issues and exact contract schema; fixed-key repairs envelope applies only authorized targets.

- [x] Test true prior field failures, untouched data equality, malformed/extra repairs and unparseable fallback.
- [x] Implement within the existing second format round, then enforce original whole-schema and semantic validate.
- [x] Run provider/model-output regression; preserve default behavior for other callers.

### Task 3: Small units and persistent budget

**Files:** storyboard-planning.ts, storyboard-planning-batches.ts, new storyboard-planning-budget.ts, storyboard-planning-tasks.ts and focused tests.

**Interfaces:** runStoryboardPlanningBudget(options, work(signal)); existing batch function retains checkpoints and takes optional batch size/structural repair switches.

- [x] Test a short scene follows outline + single-shot expansions, partial failure only reruns missing units, review/commit guards remain.
- [x] Implement strategy and exact-key instructions; opt into structural repair.
- [x] Persist cumulative request/token/active-time budget; test resume grants/hard stop, nested phase budgets and cancellation.

### Task 4: Integration and real acceptance

**Files:** docs/langgraph-storyboard-reliability.md, live report, selected .planning directory.

- [x] Run full backend regression, unified build, diff check and independent review.
- [x] Start isolated service with existing config and same model; run representative storyboard/review/commit/idempotency flow.
- [x] Verify exact Langfuse traces, task budget and settled attempts; report measured successes/failures and costs as known.
- [x] Stop own acceptance service and preserve evidence; commit/push the reviewed delivery.
