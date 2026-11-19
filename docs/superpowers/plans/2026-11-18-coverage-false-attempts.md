# Coverage false attempts implementation plan

**Goal:** Recover the two 00:04 appearance units without regenerating nine successful profiles or consuming attempts for local replay.
**Architecture:** Preserve legacy exact bindings and receipts; add a versioned coverage-only recovery ledger that counts actual dispatches, safe shape normalization and fixed missing-field patches. Project the same capabilities in API and UI.
**Execution:** Native in main, already authorized; no subagents, paid models, production writes, commits or pushes. Existing changes and history remain intact.

- [x] Reproduce four exhausted local attempts using anonymized actual response shapes and legacy checkpoint bindings.
- [x] Normalize only complete exact unique-key arrays; retain prose evidence as untrusted source and request only missing/invalid fields. Preserve valid siblings; reject ambiguous keys/quotes/relations.
- [x] Prove legacy replay versus actual requests, preserve unknown-delivery fences and real limits, append versioned migration/dispatch audit. Bind tokens to source, prompt/schema and exact retained history.
- [x] Recover only two failed shots; reuse successful IR and nine profiles. Align API/UI counters and actionable labels.
- [x] Read Langfuse and DB facts without mutation; isolate full API/transport replay, idempotence and counterexample tests; build and document limits.
