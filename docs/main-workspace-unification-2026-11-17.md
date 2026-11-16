# Main workspace unification — 2026-11-17

The application runtime and subsequent development commands use `/Users/caoyanzu/workspace/ai-video-creation-tools` on `main`.

Preserved snapshots:

- Workspace before integration: `1e1aee0`.
- Integration worktree before integration: `5687e2b`, branch `codex/preserved-integration-20261117`.
- Code patches, file archives, local configuration copies and consistent SQLite backups: `data/backups/main-unification-20261117-010638/` (local only; not committed).

Conflict resolution preserves the workspace's request ledgers, explicit scoped recovery and extraction UI together with the integration worktree's default extraction without automatic quality-review loops, completed-source reuse, historical-message handling, storyboard dialogue/timing recovery and outline checkpoint counts. Identical original uploads preserve their version boundary and existing drafts. Unknown accepted requests remain protected from automatic replay; the stream retry fixture explicitly marks a response as terminated.

Validation after resolving conflicts:

- Critical backend regressions: 141 passed, including no-review extraction/reuse, model output correction, storyboard chained recovery/timing/checkpoints and Langfuse tracing.
- Critical frontend regressions: 98 passed, including source upload, historical messages and storyboard continuation.
- Architecture and UI component guards plus shared/backend/frontend builds passed.
- The broader historical suite is not a green baseline: the pre-integration workspace snapshot had 220 backend failures and 18 cancellations. The first merged full run also exposed incompatible historical review expectations; it is not claimed as passing. The critical regression runs above are the acceptance evidence for this integration, not a claim that all legacy tests pass.

No provider model was called during validation. Existing business data and resumable checkpoints are retained. The previous storyboard task has not been resumed; its local 18-shot timing repair and UI fix are included in the integrated code.

The app's attach_worktree action rejects the primary checkout (it accepts registered linked worktrees). Commands must therefore explicitly set the primary workspace as their working directory when this chat retains its former attachment. The original worktree directory is retained; its application services are stopped.
