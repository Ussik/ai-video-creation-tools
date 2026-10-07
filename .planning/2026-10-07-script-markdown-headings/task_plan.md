# Script outline Markdown headings

Goal: Diagnose and fix literal heading markers in applied director-chat outlines and canvas previews.

- [x] Trace generation, persistence, editor parsing and preview resolution.
- [x] Handle compact Chinese headings and preserve literal-text round trips.
- [x] Keep parsed formatting in the project script preview.
- [x] Verify parser, Tiptap, preview rendering and frontend build.

Decisions: Reuse the existing Markdown codec. Limit compact-heading compatibility to Chinese text; keep ordinary hashtags literal. Preserve existing worktree changes.

Errors: Plan resolver reported multiple unpinned plans; this task uses its own directory and explicit PLAN_ID.

Regression baseline: Two new tests failed before the fix, reproducing compact-heading parsing and real Tiptap rendering failures.

Verification: 22 focused tests pass; frontend build and git diff --check pass. Ego Lite space 70 verified the existing screenshot project, with real H1/H2 elements in canvas and editor. Opening the editor leaves Save disabled.

Tool errors: Searches for guessed backend filenames found no files; used existing script-workflow.ts. A browser wait matched ten editors; inspected current editor state and used scoped DOM observation instead.
