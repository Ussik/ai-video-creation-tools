# Source Automatic Recovery Implementation Plan

> Implement natively in this session on main as explicitly requested. No agents, paid calls, live retries, data writes, restarts, commits or pushes. Preserve dirty changes. User execution constraints override skill approval/test/commit defaults.

**Goal:** Upload once; automatically process bounded technical corrections, retain successes and stop only for unresolved decisions or delivery uncertainty.

**Architecture:** Existing Zod, structured-output adapters, persisted source snapshots and LangGraph remain authoritative. Add one shared dispatch recovery budget; keep exact-response identity and unknown-delivery protections. Local boundary transfers preserve original candidates and replay a verifiable page-plan journal. Continue only independent synthesis siblings after completed validation failures.

**Tech Stack:** TypeScript, Zod, LangGraph, existing Langfuse observation pipeline.

**Spec:** User delegation in this chat, 2026-11-16.

- [x] Enable bounded syntax planning and preflight complete syntax coverage.
- [x] Persist recovery request limits, request identities and outcomes; expose fixed diagnostic counters.
- [x] Transfer title-only page tails and all their facts to untouched adjacent work without relaxing evidence validation.
- [x] Save independent synthesis successes despite another completed validation failure; retain dependency barriers and unknown/budget stops.
- [x] Focus existing status card on automatic correction and final unresolved items.
- [x] Perform necessary offline targeted checks only. No full builds or repeated old UI test loops.

Library assessment: LangChain output-fixing parsers can rewrite full candidates and dispatch additional requests; they do not enforce frozen fields or durable delivery identity. jsonrepair is not installed; its general repairs (e.g. adding closing containers) cannot prove transport completeness or source semantics. Retain the existing strict parser/Zod adapters and insertion-only repair planner, with whole-document coverage preflight. Do not introduce a new parser dependency or broad auto-acceptance for this incident.

## Actual implementation and verification

- Unified source structured-output policy now retains bounded syntax planners even in local-only mode. Fixed-line repair first proves syntax coverage with inert placeholders, then permits only backslash insertion before original quotes. Zod and domain validation remain mandatory. Unsafe repairs stop with original responses retained.
- Snapshot-owned automatic recovery journal reserves before dispatch: 12 requests globally, 2 per exact structured task, 1,000,000 reserved input/output characters. Each request reserves input plus 64,000 output characters, adjusts upward to actual output length. This is a character/request guard, not a currency estimate or provider token cap; existing workflow usage budget still applies. Same-source explicit starts retain the journal. Identical patches and unknown delivery never buy another automatic request.
- Retained partial patches can open a bounded child checkpoint only when some fixed targets succeeded, some remain, and hashes bind a completed automatic parent correction. Parent bytes/allowance stay intact. Reconciliation follows active leaf, including unknown child delivery.
- Heading-tail recovery handles explicit Markdown heading/blank tails only when all primary events/appearances are in an untouched adjacent window. All text, events, character facts and IDs are retained. Journal replays exact changed boundaries on checkpoint restoration. Other ambiguous ownership cases fail closed; no arbitrary reference widening.
- Independent synthesis siblings continue after complete validation failures. Character discovery/overview dependencies remain barriers. Unknown/budget/admission errors stop further scheduling; partial results do not become a complete story.
- Langfuse fixed metadata includes recovery action/type/attempts/input-output character counts. Existing provider request spans hold actual token usage. No claim of live Langfuse acceptance from this offline check.
- Persisted source runtime events feed existing DirectorActivity in chat; running steps visible without opening process details. Source technical details expand inline; unknown risk confirmation appears once in place. Creative task activities retain their existing persistent event mechanism. No chain-of-thought content is generated.

Focused offline checks: 9/9 passed, including automatic syntax patch, durable limit, unknown non-resend, partial target continuation, independent scheduling, nested unknown and persisted activity. Actual incident 3959 read-only snapshot replay moved boundary 2994 -> 2944, preserving 2 events and 2 characters verbatim; strict evidence passed. No live database write.

Type checks: backend/shared source and frontend noEmit passed under the temporary source-mapped effective config. Initial combined strict backend config surfaced pre-existing shared production-directory noUncheckedIndexedAccess issues; shared's own config does not enable that flag. No full build or old UI regression sweep, no browser acceptance, no provider calls by this implementation session.

Service handoff: main /Users/caoyanzu/workspace/ai-video-creation-tools. Existing tsx watch automatically reloaded backend PID23736 at 2026-11-16 00:49:16 CST; shared watch emitted updated recovery code, Vite serves 8888. GET /api/projects and frontend returned200. Read-only DB showed no queued/running source/director tasks and all10 request attempts settled. No explicit restart was necessary. If development services need starting later, use npm run dev at repository root (starts shared watcher/backend/frontend and loads local configuration).

Real acceptance to first episode saved remains assigned to the user's side chat, project d7d933f740184e41a2055c9f1b15d2ca. Do not describe this implementation as completed live business acceptance. Existing changes preserved; no commits/pushes/data cleanup.
