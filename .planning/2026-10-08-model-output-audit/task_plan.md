# Model output and Function Calling audit

## Goal
Explain how the screenshot's question options are produced, and audit which current creative-model features should use structured output, Function Calling, both, or deterministic application logic. Analysis only; preserve existing implementation and user data.

User expanded the scope to all current project features, with a professional assessment of prompt-only tasks and combined mechanisms. Reuse the completed dialogue audit and inspect previously uncovered canvas/media/Skill/catalog/editor paths.

## Phases
- [x] Trace question UI, native ask_creator and legacy recognition.
- [x] Inventory text-model calls, schemas, side effects and provider protocol constraints.
- [x] Recommend boundaries and priorities with concrete code references.
- [x] Inspect all frontend entry points and generation context/media/Skill/control paths.
- [x] Produce a complete Chinese audit with current state, recommended combinations, priorities and validation limits.

## Constraints
- No real paid model calls, database mutations, browser project mutations, commits or push.
- No implementation changes or subagents requested.
