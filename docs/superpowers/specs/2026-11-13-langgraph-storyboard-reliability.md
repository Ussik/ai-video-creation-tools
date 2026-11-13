# LangGraph storyboard reliability

Use LangGraph for the existing prepare/generate/review/repair/recheck/finish workflow without moving model adapters, task identity, SQLite checkpoints, cancellation, idempotency or commit gate. Do not enable LangSmith or use a second checkpointer.

All new plans, including short scenes, use a compact whole-scene outline followed by at most one shot per expansion request. Scene direction has explicit exact keys. Each valid unit is retained before the next call; only assembled whole validated output may reach review and commit. Existing valid durable candidates remain usable.

For parseable invalid structured output, one bounded opt-in repair requests only fixed application-selected subtrees, copies all unaffected values, then validates the entire original schema and business constraints. For invalid JSON, never guess text or invent missing data: the existing single format correction regenerates only the current small unit. No extra model selection or retry loops.

A persistent whole-task budget counts every actual request including retries and reserves uncertain token usage; it limits requests, tokens and active time in addition to existing step limits. Explicit resume reuses prior completed units and counters, and may grant a limited allowance only after budget exhaustion. No unlimited retry or silent configuration changes.

Verify graph branches, cancellation, resume/checkpoints, error-target boundaries, budget exhaustion and save gate. Run full backend/build, then the same text model on an isolated representative source scene, inspect Langfuse and real request counts. Report actual review/commit results and remaining failures without interpreting unit tests as provider success.
