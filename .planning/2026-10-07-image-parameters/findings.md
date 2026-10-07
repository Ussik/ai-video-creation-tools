# Findings

- The component already contains optional image quality/clarity/background groups and ratio tiles, but hides groups when model templates do not consume their values.
- The current gpt-image-2.5 models consume only size, with resolutions 1024x1024, 1536x1024 and 1024x1536. The backend validates resolutions against this list.
- ProjectCanvas currently hides the ratio selector for size-only models and derives ratio from the pixel size.
- The existing image popover uses oversized 680px width/124px ratio tiles, plus shared max-height scrolling. The requested screenshot uses compact three-column option groups and five-column ratio tiles.
- Global Mantine scaling turns numeric 400 into 350 CSS pixels. Explicit CSS width produces a 400px desktop panel and 366px width within a 390px viewport. All five groups fit vertically, with scrolling available on shorter screens.
- Live current-model choices: 1K and ratios 1:1, 3:2, 2:3. Other visual settings remain visible but disabled until configured. Supported quality/background options retain provider-specific values (including medium/keep aliases).
