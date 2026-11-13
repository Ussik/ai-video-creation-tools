# Video preparation status implementation plan

**Goal:** Keep image-to-video action and dialogue analysis visible until it finishes, and retain its result for review.

**Architecture:** Track preparation independently from the canvas's three-second notices. Show a small persistent status card and mark involved nodes while the request runs. Reuse existing analysis, validation, and handoff functions.

**Scope:** Multi-reference/first-frame quick actions, restoring legacy video prompts, and connecting images to videos. Keep existing working-tree changes and model choices.

- [x] Add a status card with elapsed time, persistent success/failure, locate, retry, and terminal dismissal.
- [x] Integrate state transitions into all three handoff paths; prevent stale requests from updating another canvas.
- [x] Add delayed-request integration checks for visibility beyond the notice timeout, success, failure/retry, and restore.
- [x] Run focused regressions, frontend build, and a local browser check with mocked model responses.

**Validation:** Architecture/UI guards and frontend production build passed. Four new status integration tests passed. The related regression run passed 174/176 cases; two pre-existing pure handoff tests expect 480p while current model defaults produce 720p. Generation submission tests passed 16/16 after correcting the default canvas scope fallback required by TypeScript. Browser verification observed a running status after four seconds, a retained error, successful retry, and the terminal status in light/dark themes. Model responses and graph saves were mocked; verification storage was restored.
