# Script chat layout implementation plan

> **For agentic workers:** Implement the bounded tasks below in parallel where file ownership permits; integrate and verify in the current session. The user has authorized implementation.

**Goal:** Make the script conversation easier to navigate, review and revise by clarifying layout and action priority.

**Architecture:** Preserve the current React/Mantine state and API contracts. Reorganize the panel header, current-stage status, deliverable card and composer. Use small presentation components for collapsible source context and completed activity.

**Tech Stack:** React, TypeScript, Mantine, existing CSS theme tokens, node:test/JSDOM, Vite.

**Spec:** Accepted conversation analysis and layout discussion, with the reference at `/Users/caoyanzu/.codex/visualizations/2026/11/09/01a1bf95-5739-71c1-a760-19565b2e8f64/script-chat-layout.html`.

## Global constraints

- Preserve existing uncommitted edits, model choices, generation, draft recovery and explicit-save behavior.
- No backend/API changes, paid model calls, new dependencies, commits or deployment.
- Keep failures, partial tasks, source recovery, stop controls and pending draft state visible and actionable.
- Preserve manual draft edits when submitting discussion, using the existing draft synchronization path.
- Retain theme tokens, keyboard access and narrow/short window support.

## Review focus

- A draft is open while the user enters and sends revision instructions: keep input available and sync manual edits before requesting revision.
- A source is ready, then paused/failed: expose the recovery control instead of burying it in a collapsed summary.
- A task partially succeeds or fails: do not hide recovery under the compact success presentation.
- Long project/model/document names in narrow or short windows: preserve readable controls and scrollable document space.
- A historical draft differs from the current one: suppress only the duplicate current-result action.

### Task 1: Completed task presentation

**Files:** `DirectorActivity.tsx`, `director-activity.css`, new focused activity test.

- [x] Add opt-in `compact` and `suppressDraftAction` props, with safe defaults.
- [x] Collapse successful completed activity into a keyboard-accessible summary; preserve detailed progress and abnormal recovery.
- [x] Run the focused activity tests.

### Task 2: Source context summary

**Files:** New `DirectorSourceContext.tsx`, `director-source-context.css`, focused source-context test.

- [x] Add a one-row source/map summary with mounted, expandable details.
- [x] Open recovery information for unavailable, paused and failed analysis.
- [x] Verify ready and interrupted states and keyboard-accessible disclosure.

### Task 3: Panel layout and action hierarchy

**Files:** `ScriptDirectorPanel.tsx`, `script-director-chat.css`, `director-documents.css`, panel integration tests.

- [x] Replace the first-request title with a stable title; group low-frequency header tools in a menu.
- [x] Show a compact persistent current-stage/status row.
- [x] Use one current-result card with a primary review button and secondary discussion action.
- [x] Move reply reclassification into a more menu and make completed activity compact.
- [x] Wrap source details and skill options in compact disclosures; preserve quick model selection.
- [x] Retain the composer while reviewing a draft, adapting object labels and input hints.
- [x] Verify draft edits, discussion, confirmation, source recovery and tool menus with targeted tests.

### Task 4: Verification and visual review

- [x] Build shared contracts if needed, run affected web tests, UI checks and the web build.
- [x] Inspect actual UI using an isolated local frontend fixture, without external model requests or production mutations.
- [x] Review the task diff against the saved pre-change snapshots and fix material issues.

## Verification result

- 94 affected web tests passed, including draft-edit synchronization, explicit confirmation, saved-result navigation and short-window input expansion.
- Architecture check, UI component guard, TypeScript and Vite production build passed.
- Actual local UI inspected; isolated real-component fixtures verified 440×700 and 360×400 windows, 360px viewport, light/dark appearance, menus, compact source context and failed-analysis recovery. Temporary fixtures were removed.
- No backend contracts, external model generation, commits or deployment were part of this change.

## Follow-up: composer collapse and expansion

The subsequent simplification below replaces this manual collapse/expansion design.

- Replaced the two disconnected controls with one persistent right-side button, labelled “收起” / “展开” with directional chevrons.
- A collapsed input entry retains the unsent text preview, character count, question/reference context and context-sensitive input hint. Either entry expands the mounted composer and focuses its input.
- Kept stop generation available while collapsed, preserved draft confirmation, and gave touch controls a 40px minimum height.
- Validation: 65 focused web tests passed, including retained draft state and focus restoration; architecture/UI checks and the web build passed. Browser checks covered normal and short review windows, a 360px viewport, dark appearance, touch sizing and stopping an isolated simulated reply.

## Follow-up: simplify input and configuration

- Removed the composer heading and manual collapse/expand controls. Input stays mounted and visible, including during draft review, and grows with its content within a bounded height.
- The toolbar's current mode opens a compact mode chooser and optional skill configuration, replacing the duplicate mode label and inline settings card. Questions retain the same entry. Nested skill controls stay in the parent popover while standalone workflow skill controls retain their portal.
- Source details, compact reference rows and revision scope share one scroll region above the fixed input; removed the extra source-detail scroll region. Scrollbars are hidden while scrolling remains available. Source recovery actions appear before lengthy details.
- A running conversation has one stop action in its input area. Activity cards retain progress, long-wait notices and abnormal recovery without duplicating that action.
- Cancelling a stage/document revision removes its exact automatic prompt prefix and preserves appended or rewritten creator content. Entering revision also preserves existing unsent input.
- Browser verification covered 360px touch viewports, 400px review windows, failed source recovery, three references, mode/skill selection, question controls, one stop action and cancellation of revision prompts. Temporary fixtures were removed; no external model request was made.
- Final validation: both panel integration files passed 62/62 tests; activity, source-context and skill component checks passed 22/22. Architecture/UI checks, TypeScript/Vite build and diff whitespace checks passed.
