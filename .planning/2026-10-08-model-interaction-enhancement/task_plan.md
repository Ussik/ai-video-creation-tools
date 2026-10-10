# Model Interaction Enhancement

## Goal
Implement all six agreed enhancements: protocol separation, reliable interactions, shared structured generation, explicit asset prompt contract, document completeness/impact review, and conversational visual/storyboard tools. Deliver a source-backed inventory of prompt/structured/tool combinations.

## Phases
- [x] 1. Inspect existing contracts, providers, persistence and UI; preserve previous workspace changes.
- [x] 2. Separate content/protocol instructions and repair missed question recognition with provenance.
- [x] 3. Add capability-configured structured requests, validation diagnostics and bounded correction; migrate fixed tasks.
- [x] 4. Replace raw bilingual asset reply consumption with a typed prompt result.
- [x] 5. Add completeness and scoped downstream impact information to document review/drafts.
- [x] 6. Add visual/reference/storyboard retrieval and versioned reviewable modification tools.
- [x] 7. Run meaningful regressions and both builds; write final implementation inventory.

## Constraints
Preserve unrelated work. No live paid model requests, user project mutations, commits or push. Provider capabilities are explicit configuration, never inferred from model names. Fixed UI actions use direct APIs. Skill injection continues. No delegation requested.

## Decisions
Use existing draft preview/confirm flow for conversational changes and program validation for stages, IDs and versions. Structured fixed tasks may correct invalid output once, without repeating program side effects.

## Errors
A search referenced nonexistent backend/src/schemas.ts; schema/settings files will be located via rg --files.
