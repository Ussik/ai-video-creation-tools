# Task Skill Assignment Implementation Plan

> Historical implementation, superseded by [model skill selection](2026-10-31-model-skill-selection.md). The synchronous keyword recommender described below has been removed; current behavior uses model decisions and Function Calling.

> **For agentic workers:** Implement the tasks in this session using the shared interfaces below, preserving existing uncommitted work.

**Goal:** Automatically select compatible installed creative skills for the current task, show the reason, and preserve manual control.

**Architecture:** A shared synchronous recommender consumes eligible stage policies and the current user request or structured workflow. UI freezes the resolved selection when submitting; backend recommends only where an explicit selection was not supplied. Recommendations change neither saved defaults nor generation/save authorization.

**Tech Stack:** TypeScript, React/Mantine, Fastify, SQLite, node:test.

**Spec:** User request in this chat: implement the described task-based skill assignment with visible selection/reason and manual override.

## Global Constraints

- No extra model calls for skill selection; no paid generation during verification.
- Only enabled skills eligible for the stage may be recommended; missing matches fall back to configured defaults.
- Explicit manual selections, including empty base mode, take priority; automatic choices are not persisted as manual choices.
- Review rules run for explicit review tasks; prompt refinement must continue producing rewritten prompts.
- Existing dirty application changes and existing story data must be preserved.

## Review Focus

- Stage buttons that send without editing the composer must use their actual workflow/action.
- Remembered manual prompt choices and explicit base mode must survive task changes.
- Old conversation content or quoted source text must not determine the current task.
- Disabled/missing skills and unknown requests must preserve valid fallback behavior.
- Previewed and submitted selections must agree and stay frozen during a request.

### Task 1: Shared recommendation rules

**Files:** Create shared `skills/skill-recommendation.ts` and backend unit tests.

**Interface:** `recommendSkills(policy, task: SkillTaskContext)` returns IDs, automatic/default source, reason and task label. Structured stage/action takes precedence over free text; conservative specialized routing avoids incompatible rules.

- [x] Implement and test task intent, fallback, null-base, missing skills, negation and model-specific boundaries.

### Task 2: Selection state and controls

**Files:** Update `useCreativeSkills.ts`, `CreativeSkillSelector.tsx`, API types and hook UI tests.

**Interface:** Optional task context enables recommendations. Expose selection metadata, a submission snapshot and restore-automatic control; retain existing IDs/selections API.

- [x] Implement automatic → manual → restore transitions and remembered choices.
- [x] Verify scope changes, latest task, explicit empty selections and default settings compatibility.

### Task 3: Integrate creative entry points

**Files:** Director, prompt refinement, storyboard and visual organizer; backend skill resolution and director context.

- [x] Supply current task and structured context; display reason in skill controls.
- [x] Freeze actual request selections for direct buttons and ordinary submissions.
- [x] Apply backend fallback using current task only where the caller omitted selection.
- [x] Test actual prompt construction with automatic and explicit manual selections.

### Task 4: Verify and document

- [x] Run focused backend/web tests, TypeScript builds and repository required checks.
- [x] Verify local browser selection changes without triggering paid generation.
- [x] Update skill usage documentation and record limitations.

Validation: full npm run build passed. Shared recommendation tests 5/5, backend automatic-assignment integration 4/4, web hook/selector 14/14 and three web integration suites 52/52 passed. Related backend regression: 130/131 passed; the visual-profile refresh age assertion (32 vs 21) also fails in an isolated baseline without automatic recommendation. Browser confirmed development → writing choice changes and visible rationale without submitting model work.
