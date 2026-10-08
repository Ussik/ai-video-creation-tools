# Findings

- DELETE /api/projects/:id blocks queued/running jobs, deletes project through SQLite cascades, then removes media/project-id.
- Current db.ts declares shot_visual_bindings.profile_id REFERENCES visual_profiles(id) ON DELETE CASCADE.
- Read-only inspection of data/studio.db found ON DELETE RESTRICT in the existing table. CREATE TABLE IF NOT EXISTS never upgrades this constraint.
- It is the only blocking FK; 31 shot bindings exist, foreign_key_check is clean and no custom triggers exist.
- Project cascade may delete visual_profiles before shots; RESTRICT immediately fails with SQLITE_CONSTRAINT_TRIGGER. Minimal in-memory legacy graph reproduces the same error; failed statement retains all rows.
- No tables reference shot_visual_bindings, so rebuild can stay transactional with foreign_keys ON.
- /api/visual-profiles/:id DELETE explicitly blocks deleting a profile bound to shots; preserve that behavior.
- Added schema-aware transactional rebuild before other initDb migrations. All snapshot columns are copied explicitly; FK enforcement stays ON; repeated initialization skips the rebuilt table.
- New project-deletion tests cover every project-owned table and indirect children, pinned old boards and archived candidates, shared local canvas IDs across projects, full media removal and other-project/global data retention.
- Fresh/migrated deletion, queued/running task block, individual-profile block, migration idempotence and rollback on corrupt legacy rows all pass (6 tests).
- Backend build succeeds; full backend regression passes 136/136; git diff --check is clean.
- After saving db.ts the active development server automatically initialized the new migration. Read-only follow-up confirms the actual database now uses CASCADE, retains its project and all 31 bindings, and passes foreign_key_check. No restart is required for the currently running development service.

## Resources
- backend/src/db.ts: initDb schema/migrations
- backend/src/server.ts: project deletion route
- backend/src/visual-profiles.ts: guarded profile deletion
- backend/test/canvas-migration.test.ts: isolated legacy DB pattern
