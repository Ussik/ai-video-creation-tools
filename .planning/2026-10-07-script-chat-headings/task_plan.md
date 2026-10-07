# Script chat Markdown headings

Goal: Fix compact numeric Chinese headings such as `##20集` in director-chat messages.

- [x] Trace director-message rendering to the shared Markdown parser.
- [x] Recognize compact headings whose body starts with digits and contains Chinese text.
- [x] Preserve ordinary hashtags and numeric literals.
- [x] Verify chat rendering and the full affected test/build checks.

Decision: Extend the shared heading grammar narrowly to Han text or a digit run followed by Han text. This keeps `#tag` and `#123` literal while fixing generated episode headings.

Errors: The planning resolver has multiple unpinned plans; this task uses its own directory. Existing worktree changes are preserved.

Regression baseline: The new parser-boundary test and modified Tiptap heading test failed before the fix, reproducing the screenshot symptom.

Tool diagnostics: Direct Node fetch to the local API was rejected with connect EPERM; using browser verification instead. Prior browser space 71 no longer has page p1; inspecting its page inventory before recovery.

Browser verification stopped: Ego Lite reported the user took control of space 71 and ended its task. No recovery or browser action was attempted after that notice.

Verification: All 23 focused tests and frontend build passed; git diff --check passed. Actual CanvasTextPreview SSR output contains H2 for `20集暂定总体结构`, preserves bold text, and contains no literal `##20`. Vite emitted a WebSocket listen EPERM diagnostic during the non-HTTP render check; rendering assertions passed and the server was closed in finally.
