# Director actions placement and table rendering

## Goal
Match the storyboard skill selector to the modal, place it first, distinguish composer collapse from skill selection, move next-step actions into conversation content, and render Markdown tables.

## Current phase
Complete.

## Next step
Deliver the implemented changes and validation results.

## Phases
- [x] Inspect screenshots and current components.
- [x] Move and restyle the storyboard skill selector (storyboard_skill_top).
- [x] Change composer collapse control and relocate next-step navigation (root).
- [x] Render GFM tables with scoped wrapping and overflow styles (chat_markdown_tables).
- [x] Verify director, skill, planner and Markdown tests plus frontend build.
- [x] Browser QA at desktop and narrow widths with temporary mocked fixtures.
- [x] Remove fixtures and deliver.

## Constraints
Preserve existing uncommitted work, generation behavior, drafts and references, validated next-step payloads, and skill default/switch logic. Do not invoke real model services or edit real project data during QA.
