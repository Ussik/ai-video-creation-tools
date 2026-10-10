# Task: Director skill selector styling

## Goal
Move the chat skill selector out of the crowded composer toolbar and match its trigger/popover to neutral gray chat UI.

## Phases
- [x] Inspect screenshot, selector and chat layout.
- [x] Implement compact row and popup styling with concise expandable description.
- [x] Verify desktop/narrow layout and existing selection/default interactions.
- [x] Clean test fixture and deliver.

## Constraints
Preserve existing workspace changes and skill behavior. Use mocked API/browser fixture; no real generation or project edits.

## Errors
- Initial plan replacement patch rejected duplicate target operations; corrected with direct file writes.
- Immediate browser read preceded popover transition; observed current state after mount.
- Low-window boundary assertion exposed upward popup overflow; added available-height middleware and verified popup y=12 with internal scrolling.
