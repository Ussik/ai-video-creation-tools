# Source Efficiency and Knowledge Implementation Plan

> Execution: native in this session, directly on main as authorized. No delegation, paid calls, data cleanup, UI edits, commits or pushes.

**Goal:** Reduce avoidable source-analysis work without losing facts, retain epistemic qualifications, and measure actual local validation time.
**Architecture:** Separate deterministic source positions from model interpretation. Extend current schemas sparsely and compatibly, use frozen local patches and bounded existing concurrency. Legacy completed data is reused without forced upgrades; dispatched checkpoint identities are never refreshed to buy new answers.
**Tech Stack:** TypeScript, Zod, Fastify, SQLite, LangGraph.
**Spec:** Delegated user request with historical trace 9193e078346bd00f83d08c9f1b5c1209.

## Constraints and review focus

- Preserve all pre-existing main changes and live business data; only read snapshots of original and historical responses. No automatic historical reanalysis.
- Explicit headings only; duplicates and absent headings remain uncertain. UTF-16 coordinates must slice the unchanged source exactly, including prefix and parent sections.
- Main timeline ownership differs from supporting references; local corrections freeze valid siblings, never silently delete unmatched facts.
- Equal names are not equal identities; exact duplicates can be removed, identity decisions remain evidence based and can request full source.
- Schema/reference validity never certifies truth; later revelation appends evidence, old missing annotations remain unknown.

### Task 1: Deterministic positions and compact output contract
Files: new shared script-source-position-index.ts; source-documents.ts, source-analysis.ts, shared source-document types; offline tests.
Interface: sourcePositionIndex(content) returns source-backed parent/episode ranges, duplicates and coverage. Expose separately from semantic sections. Prompt supplies computed coordinates and concise locator summaries (1200 max, target <=240); facts remain in event/character/rule entries.
- [ ] Test 60 real headings, Markdown, duplicates, no-heading, prefix/range exactness.
- [ ] Implement and verify source unchanged, no new model calls, no auto reanalysis.

### Task 2: Sparse epistemic claims
Files: new script-source-knowledge.ts shared/backend; map validation, synthesis prompts, documents contexts and revision reuse.
Interface: optional knowledge[] stores category/statement/kind/holder/status/at_unit_id/unit_ids and later updates. Validate only technical shape and coordinates, retain qualifications downstream. Legacy omission stays unannotated.
- [ ] Test suspicion/statement/plan/denial and delayed disclosure, invalid references, legacy compatibility.
- [ ] Integrate in current structured output, persistence and contexts without another model step; revision references remap or invalidate safely.

### Task 3: Timeline scope and delta repair
Files: new script-source-timeline-scope.ts; story-parts.ts/story-plan.ts/shared types.
Interface: primary_section_id plus auxiliary section_ids, explicit assigned ranges and sibling coverage; fixed candidate hash/item IDs for only invalid items. No automatic deletion of unmatched external facts. Bounded correction retains original/correction and valid sibling bytes.
- [ ] Test cross-section supporting evidence and out-of-scope main ownership; patch bindings, unknown outcomes and frozen valid entries.
- [ ] Wire current local planner, preserving existing dispatched identities and legacy results.

### Task 4: Character merge workload
Files: story-parts.ts and character-context helper/tests.
Interface: exact duplicate elimination before identity checks; evidence-scoped merge with full-source escalation; independent tasks use existing max-2 pool, durable sibling results.
- [ ] Test distinct homonyms, aliases, escalation, max concurrency and resume.
- [ ] Compare offline payload sizes/request plan only, no real speed claim.

### Task 5: Accurate observations and final offline replay
Files: model-output.ts/model-result-observation.ts/model-results.ts/langfuse-tracing.ts/tests; results doc.
Interface: local validation start/end/duration, safe fixed failure codes/paths, task range/count/reuse metadata; business correction distinct from format correction.
- [ ] Mock clock tests separate provider wait and local validation, diagnostics whitelist.
- [ ] Replay stored responses offline, run regressions/build; compare UI/baseline hashes and report limitations.

Historical read-only baseline confirmed: ready analysis 297126652c9544e29807599df3b295c6, 9 semantic sections, 11377 characters, 14 completed ledger rows. Local task source:297126652c9544e29807599df3b295c6: 539729 input/94973 output tokens, 1256.116s wall duration. No business writes made for this verification. Evidence stays in /tmp/source-efficiency-20261115 and is not committed.
