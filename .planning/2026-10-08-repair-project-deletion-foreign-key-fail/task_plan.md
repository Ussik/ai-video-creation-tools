# Task Plan: Repair project deletion foreign key failure

## Goal
Delete projects and their owned references/media without foreign key errors, including legacy databases. Preserve other projects, global provider/model configuration and previous uncommitted code.

## Next Step
Complete; report the root cause, automatic database upgrade and passing verification.

## Current Phase
Complete

## Phases
### Phase 1: Requirements & Discovery
- [x] Review route, schema and real database read-only.
- [x] Identify legacy RESTRICT constraint as root cause.
- **Status:** complete

### Phase 2: Planning & Structure
- [x] Reproduce the exact SQLITE_CONSTRAINT_TRIGGER with an isolated in-memory fixture.
- [x] Choose child-table rebuild under active foreign key enforcement.
- **Status:** complete

### Phase 3: Implementation
- [x] Migrate old FK to CASCADE without losing snapshots.
- [x] Add regression coverage for fresh and migrated databases, active-task guard, retention and migration rollback.
- **Status:** complete

### Phase 4: Testing & Verification
- [x] Focused tests, backend build and appropriate backend regression.
- [x] Update findings and progress.
- **Status:** complete

### Phase 5: Delivery
- [x] Review change and report fix/current upgrade status.
- **Status:** complete

## Decisions
- Do not delete the user's actual project for verification; use temporary data/media.
- Do not commit or push for this request; preserve prior changes.
- No table references shot_visual_bindings. Rebuild in a transaction with foreign keys ON.
- Individual visual-profile deletion remains guarded by the API when shots are bound.

## Errors
- User DELETE fails: legacy shot_visual_bindings.profile_id ON DELETE RESTRICT remains despite current CREATE TABLE CASCADE.
- Two planning patches failed due to heading/placeholder mismatches; no changes applied. Replaced only this task's untouched templates.
