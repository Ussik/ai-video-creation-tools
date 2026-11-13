# Independent-shot continuity implementation plan

> **For agentic workers:** Execute the tasks below in this session using the assigned parallel workers; integrate and review the complete result before reporting completion.

**Goal:** Make independently generated shots share explicit action and sound boundaries, and expose actual cut verification in the editor used by the sample.

**Architecture:** Retain the existing storyboard and motion skills, persist their directing decisions, and compile prompts from accepted boundaries. Keep scene sound separate from shot events and timeline music. Bind checks to actual draft/media versions and reuse the existing preview/mixing path.

**Tech Stack:** TypeScript, Fastify, SQLite, React/Mantine, Node test runner, FFmpeg.

**Spec:** User-approved analysis in this chat, including the sample's hand transfer, first-frame/end-state contradiction, independent sound instructions and full-length editing-cut export.

## Global constraints

- Preserve all existing uncommitted work and legacy shot/audio records.
- Preserve verbatim accepted dialogue, speaker and lip-sync requirements.
- Do not regenerate media, replace project selections, modify installed skill bundles or rewrite the user's sample.
- No commits, pushes, installs or paid provider calls are required.
- Planned consistency and observed media consistency remain separate; no claim to have heard audio without a supported listening path.

## Review focus

- Newer image prose conflicts with the accepted opening state: show evidence and ask for a creative revision, without silently dropping either side.
- A selected predecessor or trim changes: old checks must become stale.
- Old audio plans lack scene metadata: preserve their previous rendering and known dialogue.
- A basic cut repeats an asset: each use retains independent trim and review state.
- A preview includes offscreen speech/music: trim and reposition the complete mix to the inspected cut window.

## Task 1: Storyboard planning and skill contracts

**Files:** storyboard planning/directing/clip modules, shared storyboard types, Shot DB/API types, storyboard planner UIs and focused tests.

**Interfaces:** `StoryboardContinuityPlan` version 1 persists scene and shot directing decisions; optional on legacy shots. `SceneSoundPlan` is supplied by Task 2. Optional target video model is distinct from the text planning model.

- [x] Persist and round-trip accepted directing decisions without losing compatibility.
- [x] Reuse directing/motion rules and bounded semantic review for scene and clip planning.
- [x] Check first-frame timing, adjacent action/hand/prop state and audio continuity.
- [x] Support explicit current-draft recheck; edits invalidate the prior review without rewriting user text.
- [x] Pass configured target video capabilities to planning and skill reference selection.
- [x] Verify scene/clip planning, migrations and manual-edit recheck through isolated test databases.

## Task 2: Scene sound and dialogue preservation

**Files:** shared video-prompt-audio contract, canvas video-audio-plan module and focused tests.

**Interfaces:** `SceneSoundPlan { ambience, acoustics, music_policy: 'timeline' | 'source' }`; optional `scene_sound` and `ambience_change` extend version-1 audio plans. Export `sceneSoundPlanSchema` for Task 1.

- [x] Render scene ambience and per-shot changes separately from action effects.
- [x] Keep timeline music intent out of native shot music generation, preserving explicit source-music exceptions.
- [x] Propagate confirmed scene sound only within the same creative scope, and include it in source signatures.
- [x] Preserve accepted dialogue unless an explicit, evidenced change is supplied.
- [x] Verify legacy rendering, source validation, scope boundaries and scene propagation.

## Task 3: Actual predecessor and final prompt checks

**Files:** canvas image/video context and workflow, prompt content review, final-prompt review UI/API and focused tests.

- [x] Carry selected predecessor identity and actual trim evidence in continuity context; use pixel evidence only when actually supplied.
- [x] Track predecessor/media changes without overwriting protected manual video drafts.
- [x] Extend semantic review to the complete compiled prompt, first-frame/action contradictions and adjacent state evidence.
- [x] Make final checks explicitly callable and content-bound; expose unresolved evidence before generation.
- [x] Verify stale results, protected edits and contradictory opening descriptions.

## Task 4: Basic-editor cut verification

**Files:** BasicFinalCutStudio, new focused cut-review component/helper, TimelinePreview local fade overrides, CSS and tests.

- [x] Show actual outgoing/incoming frames and editable trial cut points.
- [x] Preview both sides using current source gains/fades, positioned speech and timeline music.
- [x] Apply candidate trims only on explicit action; retain full dialogue/visual sync and minimum-duration rules.
- [x] Mark manual review stale when clips/order/trims/mix change; support repeated asset uses.
- [x] Verify mixed-window construction and UI behavior.

## Task 5: Integration and review

- [x] Build shared types, type-check backend/web and run architecture/UI checks.
- [x] Run affected backend and web tests, including isolated generation-contract and export-preview regressions.
- [x] Inspect rendered local UI where available without paid generation or altering the user's sample.
- [x] Review integrated diff and document verified behavior and remaining provider/audio limitations.

## Completion evidence (2026-11-12)

- 219 backend integration tests and 192 frontend integration tests passed.
- Full `npm run build` passed, including architecture/UI guards and shared/backend/web compilation.
- A final historical-shot adjacency regression and its related scope tests passed (38 tests); the backend was rebuilt after that change.
- Ego-browser TaskSpace 53 inspected the existing four-clip cut, loaded both real boundary frames and played the 2.4-second review window; candidate application/save/provider calls were not invoked.
- Independent integrated reviews found and resolved missing sound compilation, accepted-speech baseline loss and stale adjacency snapshots.
- Full behavior and limitations: `docs/research/2026-11-12-storyboard-continuity-contract.md`.
- The existing exported sample remains unchanged. No subjective audio or new provider-output quality claim is made.
