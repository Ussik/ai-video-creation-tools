# Progress

- Read-only investigation completed; no live model call, document mutation or service restart requested.
- Shared deadline scope and heartbeat policy added.
- Backend targeted regressions passed: 33 tests, including terminal events without socket closure, stalled headers/body, heartbeat and overall deadline, incomplete streams and native tools.
- Validating React pending-state cleanup and preserving partial replies next; reviewing timeout classification and formatting.
- First React regression run passed 9/10; one test used an exact button text selector that omitted the execution count. Corrected to the existing component selector. Idle cleanup, content retention and heartbeat/total-timeout behavior already passed before that selector assertion.
- Whole-dialogue native timeouts now record failed instead of cancelled. Added integration regression across two model rounds.
- Fixed the outer/nested deadline trace race with a shared recorder and immutable terminal statuses. Targeted backend 34/34 passed; both production builds passed.
- First full backend run: 166/179 passed; all 13 failures were sandbox-denied localhost listeners (EPERM). Escalated only the local test suite; no real model calls.
- First full frontend run: 193/194 passed; the document preview regression assumed a modal role, while this UI uses an embedded draft review. Updating its selector, then rerunning appropriate checks.
- Final full backend passed 179/179 after allowing local mock listeners. Final full frontend passed 194/194 after using the embedded review's accessible label.
- Final backend build and frontend build passed; whitespace check passed. No real model calls or edits to user documents; no commit/push requested.
- Fix is complete. Explain waiting timer vs confirmed generation, evidence limits, and stop/refresh recovery for the old request.
