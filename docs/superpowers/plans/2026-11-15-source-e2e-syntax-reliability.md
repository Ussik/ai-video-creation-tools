# Source End-to-End Syntax Reliability Implementation Plan

**Goal:** Remove the newly introduced boolean approval bottleneck without overriding historical rejection, reduce dense source output windows and test upload through durable synthesis against real failed-response shapes.
**Architecture:** Prove a unique insertion-only JSON interpretation for isolated prose lines, reject duplicate keys/ambiguous structure, then retain original bytes and run all existing field and evidence checks. Legacy spent/unknown corrections replay exactly and never gain a new request. Dense new extractions use smaller output windows while existing work plans remain frozen.
**Tech Stack:** TypeScript, Zod, SQLite, LangGraph, node:test.
**Spec:** Latest delegated real failure 7b8bcf137cf04c239a7610ec29f2e70b. Native implementation in this session; no delegation, paid requests, business writes, UI edits, service restart, commits or push.

- [x] Read-only incident evidence and candidate/prompt/response fingerprint verification.
- [x] Deterministic unique line syntax recovery with inverse insertion proof and duplicate-key rejection; legacy approval remains completed-replay only.
- [x] Small reasoned fixed local corrections for unresolved syntax; no full response/source rewrite where safe local targets are known.
- [x] Density-aware smaller windows for fresh extracts only; immutable existing work and unknown requests.
- [x] Replay saved failures offline, integrated upload/map/save/synthesis tests, history protections, full build and explicit limitations.

## Verification limits

Current focused backend 395/395, frontend 61/61, build and whitespace checks passed. Wider backend run had 18 failures and 12 cancelled tests; two outdated unknown-response expectations were corrected and verified separately, while legacy incremental/outline/concurrency/density tests remain unresolved. This is not a claim that every regression passes. Current result and exact offline evidence: `docs/research/2026-11-15-source-extraction-verification.md`.
