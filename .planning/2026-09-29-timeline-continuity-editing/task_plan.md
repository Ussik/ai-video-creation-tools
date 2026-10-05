# Timeline Continuity Editing

## Goal
Make existing projects edit and verify the actual intervals used from generated clips, preserve adjacent-shot continuity, and export the reviewed timeline without silent omissions or frozen padding.

## Next Step
Review the existing project's cut points and regenerate discontinuous footage before exporting a new version.

## Current Phase
Complete

## Phases

### Phase 1: Discovery
- [x] Inspect current project, API, database, renderer, frontend, and tests
- [x] Identify the fixed-duration and hard-cut failure path
- **Status:** complete

### Phase 2: Contract
- [x] Define timeline clip schema, migration, API, validation, and preview behavior
- [x] Assign disjoint backend and frontend ownership
- **Status:** complete

### Phase 3: Implementation
- [x] Persist editable source in/out points for selected assets
- [x] Expose adjacent cut preview and continuity controls in the studio
- [x] Render exactly the reviewed intervals and reject incomplete timelines
- [x] Add previous clip tail-frame handoff for supported models
- [x] Make AI shot planning allocate varied durations from action beats and dialogue
- **Status:** complete

### Phase 4: Verification
- [x] Backend tests for migration, validation, export and frame handoff
- [x] Build frontend and backend
- [x] Browser verification of existing project continuous playback; automated edit/export checks without model calls
- **Status:** complete

### Phase 5: Delivery
- [x] Review changed files and user data preservation
- [x] Report capabilities and remaining limitations
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Preserve existing projects and model configurations | User data must not be reset or replaced. |
| Separate planned shot duration from timeline source in/out | Generation length and final edit length serve different purposes. |
| Use model capability settings for frame handoff | No provider-specific interface path belongs in code. |
| Store one editable timeline clip per selected shot for this release | Supports source interval editing while preserving the current ordered shot workflow. |

## Errors Encountered
| Error | Resolution |
|-------|------------|
| First planning patch used delete/add for the same path | Reapplied as an in-place update. |
