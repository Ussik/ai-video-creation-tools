# Script Function Calling

## Goal
Implement the agreed ten native tools for script conversation, full document reading, durable confirmed decisions, scoped patches, draft lifecycle and confirmed saves.

## Current Phase
Complete

## Phases
- [x] Discovery and official Function Calling protocol reference.
- [x] Define ten tools and scope: project-bound IDs, bounded reads, exact passage edits, version checks, same-model evaluation.
- [x] Native Chat Completions/Responses tool session and backend project tools.
- [x] Frontend tool results, draft preview, document review/revision entries and confirmation.
- [x] Meaningful protocol, persistence, stale-write, stage and UI verification.
- [x] Final review and delivery (no commit/push requested).

## Decisions
- Preserve existing circular send button change.
- Normal script dialogue uses native tool calls. Existing specialized visual and legacy workflow routes remain available.
- Tools never expose cross-project documents. Tool errors returned to model for recovery.
- Draft save checks base content versions; saving in dialogue requires explicit current-draft approval.
- Review evaluates with the dialogue model; no extra review model.
- Skills remain in the script system prompt.
- ask_creator returns structured existing question UI; skip remains delegation.

## Errors
- Prior work was withdrawn by user; resume implementation only after explicit start. No withdrawn provider patches remain.
