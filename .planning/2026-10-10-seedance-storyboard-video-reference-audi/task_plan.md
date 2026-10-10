# Seedance storyboard video reference audit

## Goal
Verify official Seedance 2.0 reference capabilities and implement a consistent storyboard-to-video reference workflow with explicit user controls.

## Phases
- [x] Read official tutorial, API roles/limits and prompt guide.
- [x] Audit frontend handoff, reference bindings and provider/backend validation.
- [x] Specify compatible modes, inheritance, prompt mapping and user controls; report findings.

## Implementation
- [x] Add shared ordered reference manifest and explicit provider capabilities/validation.
- [x] Default compatible storyboard handoff to multi-reference; retain strict-first-frame selection.
- [x] Integrate actual reference panel, exclusions, preview/locate, prompt/skill synchronization and model preset.
- [x] Run meaningful regression tests, frontend/backend builds, and browser UI checks.

## Constraints
User authorized implementation on the next turn. Preserve existing uncommitted code; no live database changes or media generation. Do not assume first-frame and reference-image roles can be mixed without documentation.

## Mode control consolidation
- [x] Identify duplicate strategy controls and existing bottom mode menu.
- [x] Remove the upper strategy card and use one bottom menu with concise mode names and descriptions.
- [x] Verify actual mode-menu switching synchronizes references/prompt/request and locks during generation; build and check UI.
