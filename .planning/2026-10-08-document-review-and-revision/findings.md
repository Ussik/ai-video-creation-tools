# Findings

- backend/src/server.ts resolves intent using the selected model, then writes stage JSON draft.
- Ordinary context truncates artifact content to 3000 chars and first 16 docs; workflow context takes full 20000 chars but still first 16.
- Current create/revise classification is not retained in WorkflowDraft; stage draft is full document replacement.
- Saved docs have IDs, artifact type, episode number, content and updated_at; draft commit updates type/episode atomically.
- Frontend document reader supports manual edit and reference snapshots, but no dedicated review or scoped AI revision entry.
- Text providers use configurable request templates; streaming currently extracts text and ignores tool calls.
- Native Chat Completions: tools + assistant.tool_calls + role=tool messages.
- Native Responses: tools + output function_call + function_call_output; preserve reasoning/output items on continuation.
- Official reference: https://developers.openai.com/api/docs/guides/function-calling (read via Ego Lite).

## Implemented architecture

- Normal all-focus dialogue uses ten native tools; typed generation/adoption and specialized visual routes remain compatible.
- Tool sessions support configured Chat Completions and Responses templates and preserve private protocol history. Public text streams; private fields and thought tags stay hidden. Truncated calls are never executed.
- Project documents have exact content versions and bounded, paginated reads. Exact patches keep unrelated text and require evidence from read ranges.
- One persistent pending draft per project, with versioned edits, restore, discard and atomic commit. Same-turn creation cannot save itself; dialogue save is checked independently with the selected model. A status route recovers saves when stream delivery fails.
- Episode patches synchronize selected existing scene fields and retain scene IDs and shot bindings. Existing scenes are not recreated.
- Decisions retain actual user-message sources. Explicit configuration decisions can synchronize episode count/runtime without saving document bodies. Legacy generation prompts also receive these decisions.
- Document reader adds model review and dialogue revision; drafts show full original and current content, support manual edits, and synchronize those edits before further model dialogue.
- Skill injection remains in the native script prompt and was verified with an enabled fixture skill.
