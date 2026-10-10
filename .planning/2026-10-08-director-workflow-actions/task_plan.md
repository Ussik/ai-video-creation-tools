# Dialogue-driven creation workflow

## Goal
Make story direction part of the initial conversation, show one current next step, and route stage generation through native Function Calling while preserving Skills, reviewed drafts, scoped revision, explicit stage selection and per-episode storyboard handoff.

## Phases
- [x] Inspect current workflow, tool registry, action rendering and pending changes.
- [x] Add server-validated, persistent next-step proposals and authoritative creation state.
- [x] Unify stage buttons with tools and replace duplicate fixed UI actions with contextual actions.
- [x] Cover readiness, stage order, drafts/saving/revision, persistence, Skills and per-episode handoff with regressions.
- [x] Build, run appropriate full checks, and deliver results.

## Constraints
- Preserve the uncommitted native tools, execution trace and stream-timeout fixes.
- No live paid model request or mutation of user projects during QA.
- No commit/push requested. No subagents authorized.
- Keep deterministic explicit confirmation saving. Keep skipped-question wording and delegated semantics.

## Initial findings
- The two fixed buttons are always rendered independent of dialogue readiness.
- Typed stage buttons set workflow and disable use_tools, creating a second generation path.
- Native ask_creator is typed, but native tools cannot propose a generate action; frontend also derives actions from parsed replies and saved-document fallback.
- Saved workflow progress handles outline, characters, locations, props and episode, with direction folded into outline preparation. Per-episode storyboard handoff already accepts saved episode selection.
