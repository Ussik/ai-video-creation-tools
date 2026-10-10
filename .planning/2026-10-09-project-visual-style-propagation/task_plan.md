# Project visual style propagation

## Goal
Implement durable project visual style, Function Calling normalization/read/update, shared final prompt compilation for boards/assets/images/videos, versioned previews and stale reference review, synchronized canvas prompts and validation.

## Phases
- [x] Implement shared style contract, project persistence and tools, including compatible recovery for legacy confirmed style context.
- [x] Integrate all prompt/generation paths and reference/style version checks.
- [x] Surface inherited style and stale references; synchronize editable prompts and actual requests.
- [x] Run meaningful isolated regressions and builds; inspect final diff.

## Constraints
Preserve prior dirty changes. No paid real model calls, no real project writes, no Git commit/push. Semantic interpretation belongs to model tools; avoid keyword guesses of genre as art style. Historic assets remain intact.

## Errors resolved
- Atomic patch anchor/duplicate path issues: corrected against current source before applying; failed patches made no edits.
- Local mock server listen EPERM: ran the isolated test suite with approved local-port access.
- New fixture missing /api prefix and frontend created_at: corrected fixtures.
- Template regression treated public model settings as serialized JSON: accept the returned object as well as a string.
- Legacy director test lost an unsaved style preference during discussion: retain unconfirmed preference only for discussion without canonical style; unrelated decision persistence still excludes it.
- Browser locator without a role name and stale snapshot refs: read current page state and use documented selectors; no real-project action involved.

## Final verification
Backend 210 tests pass, frontend 213 tests pass; both production builds and git diff --check pass. Isolated actual ProjectCanvas browser checks pass. Temporary QA source files and Vite/browser tasks cleaned up.
