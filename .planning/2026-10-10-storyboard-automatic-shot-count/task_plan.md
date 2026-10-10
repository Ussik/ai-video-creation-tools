# Storyboard automatic shot count

## Goal
Allow 每场建议镜头数 to be blank so the model decides a suitable count per scene using story, dialogue, action and duration; explicit numbers stay suggestions.

## Phases
- [x] Audit active planner input, payload and backend defaults.
- [x] Default frontend to blank and send no count for automatic planning.
- [x] Remove backend count fallback; preserve timing, continuity and source identity validation.
- [x] Verify frontend interactions, backend model contract, builds and cleanup.

## Constraints
Preserve all earlier local edits. No real model calls or project writes for testing. Keep installed skill selection and execution behavior unchanged. Legacy unopened AI split modal is out of scope.
