# Task Plan: AI observability — Langfuse

## Goal
Replace the uncommitted LangSmith integration with optional metadata-only Langfuse tracing, a local self-hosted deployment and synthetic acceptance.

## Next Step
Langfuse v4 implementation, local deployment and acceptance complete; deliver this reviewed change on codex/langfuse-observability.

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
- [x] Replace LangSmith with Langfuse
- [x] Prepare isolated local self-hosting
- **Status:** complete

### Phase 4: Testing & Verification
- [x] Verify requirements met
- [x] Document test results
- **Status:** complete

### Phase 5: Delivery
- [x] Review outputs
- [x] Prepare verified local deployment and Git delivery
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|

## Errors Encountered
| Error | Resolution |
|-------|------------|

## Final Acceptance
- Langfuse web/worker4.79.0 with ClickHouse26.3.62.3, loopback-only ports and private generated configuration. All local dependencies healthy.
- Real synthetic OTLP export and exact root/direct-child v2 readback passed; browser OSS4.79 login/list/details verified. No paid model calls.
- Exporter13/13, diagnostics8/8, local tooling6/6; unified build and isolated backend3260/3260 passed. Independent review has no P1/P2.
- User business service was not restarted. Activate tracing on this enhanced branch by loading .env.langfuse.local using the documented startup command.
