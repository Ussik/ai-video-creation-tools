# Task Plan: Seedance 2.0 prompt optimization

## Goal
Apply the reviewed official Seedance 2.0 guidance to existing prompt refinement and reference selection, fix Mini-specific rule loading, and enforce the current model's nine-image limit.

## Next Step
Complete. User can use 整理提示词 and 按镜头推荐 with the updated Mini configuration.

## Phases
- [x] Requirements and official guide comparison — complete
- [x] Trace current skill selection, reference suggestions, and explicit capability configuration — complete
- [x] Implement and document changes — complete
- [x] Run focused behavior/integration tests and builds — complete
- [x] Review changes and deliver — complete

## Decisions
- The user authorized optimization after the guide review. Seedance 2.5 work remains deferred.
- Keep external installed skill bundles immutable; add application-owned rules that preserve the JSON contract and actual image order.
- Recognize official Mini/Fast names and explicit 2.0 dialect labels for rule selection only. Do not infer provider transport or replace existing video templates from a name.
- Prefer face identity before costume/body view; retain back-view behavior and manual frozen selections.
- Apply the current official Mini model's nine-image limit explicitly in its configuration, preserving edit/extend and video-reference templates.
- No commits, pushes, installs, media generation, or paid external calls.

## Errors
- Optional discovery paths skill-defaults.test.ts and config.ts were absent; used skills.test.ts and server.ts.
- Plan update used backend cwd and failed to find the relative plan path; corrected to the absolute task path.
- Two existing generation tests expect optional excluded profile text; reproduced with pre-task visual-prompt and reference-selection implementations in an isolated source copy. Existing server filtering is unchanged in this task.
