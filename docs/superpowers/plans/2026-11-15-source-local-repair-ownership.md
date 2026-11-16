# Source Local Repair Ownership Implementation Plan

> **For agentic workers:** Execute these tasks in this session. No delegated work or paid model calls.

**Goal:** Replay both completed paid corrections safely; preserve valid fields and correction protection on resume.

**Architecture:** The program owns immutable proposal fields. Current wire schemas expose only mutable fields and allowed evidence IDs. Exact historical request fingerprints select replay adapters; adapters discard model copies of immutable fields and still validate every mutable operation. Resume preserves completed responses and dispatch intents.

**Tech Stack:** TypeScript, Zod, node:test, SQLite read-only diagnostics.

**Spec:** User delegation dated 2026-11-15 in this chat.

## Global Constraints
- Work on main; preserve unrelated modifications. No commit or push.
- No provider calls, business database edits, model/config changes or automatic evidence substitution.
- Private partial repairs never imply analysis ready or independent quality passed.

## Review Focus
- Harmless prose with a single complete JSON fence vs multiple roots/fragments.
- Legacy descriptions changing punctuation never acquire ownership of frozen text.
- Multiple bad targets report together; valid operations remain reproducible from retained raw.
- Unknown request fingerprints and unresolved intent cannot dispatch on resume.
- Per-target evidence bounds and whole-section count limits remain enforced.

### Task 1: Field ownership and complete local diagnostics
Files: generation/model-output-local-repair.ts, generation/model-output.ts, script/script-source-map-local-repair.ts, corresponding test.
- [x] Add ownership tests: evidence-only replacements contain evidence only; mutable text is allowed only where the original field is invalid.
- [x] Add exact historical replay adapter; inspect all targets and retain valid operations in a private error candidate.
- [x] Run local repair tests and both real saved responses offline, with provider generator hard-failing if invoked.

### Task 2: Resume semantics
Files: script/script-source-analysis.ts, script/script-source-checkpoints.ts, integration tests.
- [x] Preserve correction/intent and prepared/completed domain-repair checkpoints on explicit resume; only existing failed domain stages retain their explicit retry behavior.
- [x] Explain local revalidation in resume messages; no full correction reset.
- [x] Test service restart/continue with completed and unresolved correction checkpoints.

### Task 3: Apply and verify
- [x] Verify main file hashes and inactive runtime before applying only this patch.
- [x] Run focused integration tests, backend typecheck, repository architecture check and diff whitespace check.
- [x] Verify live health without submitting a generation. Record real semantic blocker and unperformed quality check.
