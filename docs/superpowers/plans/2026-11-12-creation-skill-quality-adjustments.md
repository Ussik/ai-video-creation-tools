# Creative Skill Quality Adjustments Implementation Plan

> **For agentic workers:** Implement the approved tasks in this session, with independent workers for storyboard context, dialogue boundaries, and skill selection. Preserve existing uncommitted changes; do not commit the mixed workspace.

**Goal:** Preserve creator intent across production stages and tighten the five implementation boundaries identified in the approved source review.

**Architecture:** Reuse existing requirements, decisions, skill selection, preview approval, and independent review mechanisms. Keep the nine task defaults and manual selection precedence. Changes remain local to the owning modules and are verified through mocked model contracts and source invalidation tests.

**Tech Stack:** TypeScript, Zod, SQLite, Fastify, React, Node test runner.

**Spec:** The five adjustments approved in this conversation on 2026-11-12, detailed below.

## Global Constraints

- Preserve the dirty working tree and all existing project content and configuration.
- Do not call real generation providers or mutate the live Studio database for validation.
- Current creator instructions take precedence; documents and skill references do not create new user instructions.
- Independent clip creation must not inherit unrelated formal-story facts.
- Artistic suggestions do not block draft acceptance; factual/explicit contractual conflicts may block.
- Native third-party skill tools remain disconnected; do not silently disable manual selections.

## Review Focus

- A requirements-only update must invalidate affected storyboard proposals and saved source fingerprints.
- Clip generation must not acquire episode-specific plot or instructions from a different workflow.
- Dialogue edits must preserve surrounding action, narration, layout, and non-dialogue scene fields through draft continuation and save.
- Fresh review findings missing severity must request format correction; explicit suggestions must remain nonblocking.
- A known target video dialect must exclude incompatible dialect references while retaining general references and unknown-target compatibility.

## Task 1: Storyboard creator context and freshness

**Files:** storyboard-planning.ts, clip-storyboard.ts, storyboard-freshness.ts, a focused context helper if needed; their backend tests.

**Interfaces:** Consume the existing effective creator requirements, confirmed decisions, generation options, selected scenes, and project. Produce the same scoped context for generation, directing review, and signatures.

- [x] Add regressions for creator-context inclusion and requirements-only invalidation.
- [x] Reuse structured scope/provenance; include relevant inputs consistently in both prompt and source version.
- [x] Verify formal-story facts do not enter standalone clip context.
- [x] Run storyboard planning, clip, directing, and invalidation regression tests.

## Task 2: Consistent ending requirements

**Files:** backend/src/modules/script/script-workflow.ts; backend/test/script-stage-content.test.ts.

**Interfaces:** Keep workflowContentInstructions(request) and artifact types unchanged.

- [x] Assert outline/episode instructions no longer require every episode to end in suspense.
- [x] Replace mandatory suspense wording with episode outcome, emotional landing, continuing interest, and applicable continuity. Suspense follows genre and explicit creator requirements; finales honor resolution.
- [x] Run script stage-content and workflow regression tests.

## Task 3: Dialogue revision boundaries

**Files:** script-document-tools.ts, a focused dialogue-range helper if needed, script-dialogue-revision.test.ts and relevant document-tools tests.

**Interfaces:** Preserve existing exact replacements, source versions, preview, and approval protocols. Enforce the same dialogue boundary on initial proposal, continued draft, and commit.

- [x] Add regressions for legitimate dialogue edits and attempted changes to action/narration.
- [x] Bind edits to reliable source dialogue ranges; do not guess semantic content using keywords.
- [x] Preserve expressive dialogue and fail with actionable feedback when scope cannot be established.
- [x] Run dialogue and document tool regressions.

## Task 4: Skill integration scope and dialect compatibility

**Files:** skills.ts, model-skill-selection.ts, skill-routes.ts, skill selector/shared types as needed; skill/reference and selector tests.

**Interfaces:** Expose rules-only integration limits consistently to the selector and model. Pass structured target dialect into optional reference eligibility.

- [x] Add regressions for native-tool descriptions and known/unknown target dialects.
- [x] Keep manual/default selection precedence and defaults intact.
- [x] Mark disconnected tool workflows as method references and filter incompatible known dialect documents.
- [x] Run skill selection/reference and affected web tests.

## Task 5: Required severity for fresh reviews

**Files:** script-draft-completeness.ts; dedicated severity tests and affected review fixtures.

**Interfaces:** Fresh model output requires severity = blocking | suggestion. Legacy checkpoint compatibility is separate from new-output validation, preserving old evidence and actual blocking findings.

- [x] Add regressions for missing/null severity correction, nonblocking suggestions, explicit blockers, and legacy cached results.
- [x] Separate legacy parsing from strict fresh model contracts, including paginated/retained findings.
- [x] Run completeness, evidence, recovery, reasoning, and scoped-review tests.

## Integration validation

- [x] Run architecture/UI checks and TypeScript builds.
- [x] Run the focused backend/frontend suites covering changed modules, then independently review the implementation.
- [x] Record observed validation and any real-model limitations; do not claim measured creative quality improvements.

## Completed validation

- Unified backend regression: **750/750** tests passed (`/tmp/creation-quality-backend-final.log`).
- Unified frontend regression: **151/151** tests passed from the web workspace (`/tmp/creation-quality-web-final.log`).
- `npm run build` passed, including architecture/UI checks, shared/backend TypeScript builds, and Vite production build (`/tmp/creation-quality-build.log`). Vite retains the existing large-bundle advisory.
- Independent workers cross-reviewed storyboard scope/isolation, dialogue boundaries, and severity/ending contracts. Follow-up review closed the independent-clip project-brief input leak.
- Regression exposed an existing activity-duration defect: a resumed repair's final aggregation time overwrote its full logical duration. A minimal fix in `script-activity.ts` retains the original logical span while preserving checkpoint replay durations; original assertions remain intact.
- `git diff --check` passed. No commit, live database mutation, or real provider/media generation was performed.

## Operational behavior and limits

- Explicit current instructions override applicable saved defaults. Formal storyboard fingerprints now include active applicable requirements, confirmed decisions, and relevant saved settings; older saved plans with newly tracked context can require replanning.
- Requirement scopes support `project`, `项目级`, `episode:N`, `scene:ID`, and `clip`. Existing free-text scopes remain labelled context for formal scenes and are conservatively tracked. Independent clips exclude unscoped requirements and formal-story decisions, outline, character notes, episode structure/timing, and project brief; they keep explicit project/clip constraints and art defaults.
- Dialogue-only edits add independent structured boundary review for changed document/scene targets before a preview is persisted. Unchanged approved previews reuse the full source/candidate fingerprint. Manual changes invalidate that stamp and need continued dialogue review, or an explicitly ordinary revision, before saving.
- Boundary recognition still depends on model semantics. Exact quote/occurrence checks protect all remaining bytes; uncertain classification is a recoverable refusal rather than automatic permission.
- Fresh whole, paged, and recovered model findings require explicit severity. Legacy persisted report parsing remains separate and preserves old blockers.
- Nine task defaults and manual selection precedence are unchanged. Skills still supply rules and text references; their native tools are not connected. Only references with a known incompatible model dialect are excluded; unknown targets/documents remain available.
- These tests verify routing, contracts, preservation, and invalidation using mocked models. They do not establish real-model artistic quality, latency, or generation cost.
