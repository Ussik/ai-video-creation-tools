# Image generation parameter panel

Goal: Replace the image pixel-size controls with the reference layout: quality, clarity, background, ratio tiles and candidate count.

- [x] Inspect the panel, model configuration and request handling.
- [x] Implement reference-style image groups and fixed-size mapping.
- [x] Verify supported selections, persistence, request preview and responsive layout.

Decision: Keep model capabilities authoritative. Display reference choices, disable unconfigured values and map available clarity/ratio choices to supported pixel sizes. Preserve video controls and existing worktree edits.

Errors: Initial searches included nonexistent guessed filenames; subsequent inspection used repository file names. A guessed tsconfig.app.json did not exist.

Verification: 16 focused tests and final frontend build passed; git diff --check passed. Ego Lite space 71 verified 3:2 maps to 1536x1024, four candidates appear in request review, restored settings persist as 1024x1024/1:1/1 candidate, and all panel content fits on desktop and a 390px narrow viewport. No generation submitted.

Browser diagnostics: CSS text-is selectors did not match split text, so current snapshot refs were used. Mobile emulation exposed the pre-existing application's wide viewport; a 390px CSS viewport confirmed the panel itself fits. Initial panel dimensions were reduced by Mantine scale and shared max-height; replaced with explicit CSS-pixel width and viewport-height cap.

Cleanup: A width wait after clearing emulation timed out because the panel did not remain open; checked current state and finished the same browser task without repeating the wait.
