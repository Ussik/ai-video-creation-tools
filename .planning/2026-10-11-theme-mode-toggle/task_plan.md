# Global light and dark mode

## Goal
Add an accessible global theme button, persist the selection, and make workspace surfaces and body portals readable in both themes. Preserve existing media, project state and interactions.

## Phases
- [x] Inspect Mantine configuration, global tokens, navigation and existing work.
- [x] Add the shared toggle and persistent Mantine color scheme; define the light palette.
- [x] Adapt remaining fixed UI colors and validate key pages, portals and mobile layout.
- [x] Run focused tests, UI guard and production build; update the design-system documentation.

## Decisions
- Reuse Mantine scheme management and root data-mantine-color-scheme.
- Keep dark as the initial default for users without a saved choice.
- Provide top-right controls in project/workspace/canvas/editor headers.
- Preserve unrelated uncommitted work.

## Errors
- Default sandbox could not connect to ego-browser bootstrap; no space was created. Retry with scoped access.
- apply_patch rejected replacing planning templates with delete/add for the same paths; use direct text writes instead.
