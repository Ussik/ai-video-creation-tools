# Findings

- `CanvasGenerationParameters` currently synthesizes defaults for all image quality/background/clarity/ratio options and disables values absent from model settings.
- The live `gpt-image-2.5` settings only contain `resolutions: 1024x1024, 1536x1024, 1024x1536`; its request template consumes only `size`. Therefore quality/background are unsupported, and fixed sizes derive only `1K`, `1:1`, `3:2`, `2:3`.
- Current image popup width is 400 CSS px and its image tiles use 40px options / 76px ratio tiles, which is visually oversized in the user's canvas screenshot.
