# Repair stuck director stream

## Goal
Identify the user's 24-minute pending dialogue and prevent endless waiting across model, server and browser streams without discarding received content or reissuing requests.

## Phases
- [x] Read screenshot, current database metadata, service process age and stream implementations.
- [x] Stop on protocol completion, enforce bounded stream waits, add server heartbeats and preserve partial replies.
- [x] Regression tests for open-after-completion, stalled streams, heartbeat/total bounds, abort and truncated replies.
- [x] Production builds and final explanation with limits of the available diagnosis.

## Findings
- Screenshot is the typed stage generation path; its pending label is emitted for structured document drafts.
- DB still has only the saved outline. No character draft or saved character document exists.
- Backend watch child restarted during the observed wait (child age roughly 11 minutes vs 24-minute UI timer).
- Both provider stream loops wait for EOF after terminal events; frontend also waits for EOF after `done`, with no idle or total timeout.
- Existing provider request limit is 10 minutes per call, but a whole conversation has no bound.

## Decisions
- Stop reading at valid terminal protocol events and cancel/release readers.
- Server heartbeat every 15 seconds; browser detects 45 seconds without service data. Whole dialogue limit 15 minutes; provider call limit stays 10 minutes.
- Never auto retry. Preserve received text and recover pending tool drafts after failure.
- Existing stalled tab must stop/reload to adopt new client code; cannot retroactively instrument its original request.

## Validation
- Full backend: 179/179 passed (local mock listeners permitted after sandbox EPERM).
- Full frontend: 194/194 passed, including an open-after-done document preview, idle disconnect with partial text and trace retention, heartbeats and whole-dialogue limit.
- Backend and frontend production builds passed. Vite reported the existing bundle-size warning.
- git diff --check passed. No live model request, user document mutation, commit or push performed.
