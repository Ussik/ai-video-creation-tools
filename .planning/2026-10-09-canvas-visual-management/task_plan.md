# Canvas visual management

## Goal
Replace the large visual-settings modal with canvas-native profile editing, focused bindings and secondary bulk organization without losing existing functionality.

## Phases
- Audit and map modal responsibilities: complete
- Implement editor, bindings and bulk tools; rewire callers: complete
- Verify interactions, regression tests and browser layout: complete
- Document and deliver: complete

## Decisions
- List selection does not add nodes; only plus adds.
- Use one right canvas panel at a time for profile editing/creation, bindings or bulk organization.
- Preserve model selection, editable batch review/save, revision guards and scene-to-shot bindings.
- QA uses isolated mocked APIs, no paid calls or real project writes.

## Errors
- apply_patch rejected delete/add of the same path; wrote planning text directly instead.
