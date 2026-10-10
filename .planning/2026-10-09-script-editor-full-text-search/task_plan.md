# Task Plan: Script editor full text search

## Goal
Search all script documents from the full-page editor, highlighting and navigating matches without changing saved content or undo history.

## Next Step
Deliver the completed search controls and usage instructions.

## Current Phase
Phase 5

## Phases

### Phase 1: Requirements & Discovery
- [x] Understand user intent
- [x] Identify constraints
- [x] Document in findings.md
- **Status:** complete

### Phase 2: Planning & Structure
- [x] Define approach
- [x] Create project structure
- **Status:** complete

### Phase 3: Implementation
- [x] Execute the plan
- [x] Write to files before executing
- **Status:** complete

### Phase 4: Testing & Verification
- [x] Verify requirements met
- [x] Document test results
- **Status:** complete

### Phase 5: Delivery
- [x] Review outputs
- [x] Deliver to user
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Search current artifact documents across all directory entries | Hidden documents and unsaved edits must be searchable. |
| Use ProseMirror decorations and document positions | Highlight across formatting marks without mutating text, serialization, or undo. |
| Reuse directory scroll locking for match navigation | Prevent smooth-scroll tracking from overriding the selected destination. |

## Errors Encountered
| Error | Resolution |
|-------|------------|
| Search props were attached to the artifact type in initial patch | Moved props to rich editor component type. |
| Discovery referenced absent tsconfig.app.json/index.css | Actual configuration/style files identified. |
| Local Vite listen and Ego bootstrap denied in sandbox | Retried with scoped escalation for local UI QA. |
| Temporary fixture initially nested one directory too deep | Moved only task-owned fixture to the expected Vite path. |
| JSDOM has no scrollIntoView and defaults overflow to visible | Desktop harness models auto overflow; mobile API stub added. |
| Ego subtree snapshot rejects CSS root selector | Used a full snapshot with documented API. |
| Legacy mobile styles wrapped actions and hid sticky search while scrolling | Explicit row widths, fixed mobile toolbar and readable directory overrides applied. |
