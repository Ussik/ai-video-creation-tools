# Director activity visibility

## Goal
Make actual Skill loading and native Function Calling visible in script dialogue, using LibTV's interface as a reference. Preserve completed document-tool work.

## Phases
- [x] Inspect LibTV's actual dialogue and operation details.
- [x] Implement truthful, bounded Skill/tool/model activity lifecycle and history persistence.
- [x] Add compact expandable activity UI consistent with the existing theme.
- [x] Verify streaming, repeated calls, failures, cancellation, persistence and UI; production builds and browser QA.

## Decisions
- Display real operation events and public outputs; never hidden model reasoning.
- Skills inject professional rules/reference text; distinguish this from function execution.
- Retain all tool invocations, identity, status and timings; detailed payloads have explicit preview limits.
- No commit or push requested.

## Errors
- Escape in LibTV closed the entire dialogue as well as history. Reopened TV Director using observed control.

- Edit scripts used repository-relative paths from subdirectory cwd; corrected to project cwd.
- LibTV subtree ref became stale after streaming; used fresh snapshot.
- Sandbox blocks localhost listener; use authorized escalation for Vite QA server.

## Completion
All implementation, browser QA and verification complete. No commit or push requested.
