# Default primary skill controls

## Goal
All five creative stages have a default primary and support global, project and operation switching. Alternatives do not automatically enter requests.

## Phases
- [x] Selection policy, defaults, migration and scoped APIs.
- [x] Integrate conversations, generation, visual organization and refinement; separate reads from skill loading.
- [x] Shared selector, global/project defaults and operation controls.
- [x] Test isolation, stable defaults, switching and browser layouts.

## Decisions
- Default from existing enabled recommended skill, otherwise a stable eligible candidate. Explicit project overrides take precedence.
- One primary and at most two explicitly chosen helpers. Base application rules when no external skill is available.
- No paid requests or real project writes in tests; preserve unrelated changes.

## Errors
- Combined delete/add patch for same planning path rejected; rewrote template contents directly.
- Updated old tests for default metadata and optional base rules; CSS loaders added where shared selector imports require them.
- Local Vite listen required scoped sandbox escalation; resumed the same browser TaskSpace after starting it.
- Browser QA exposed portal dropdowns closing their parent popover; fixed with contained combobox dropdowns.
- Final compiler found an unchecked indexed access in draft comparison; added the assertion justified by the validated edit map.
