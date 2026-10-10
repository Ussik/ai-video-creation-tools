# Findings

- Audit documented 38 areas. Main tool dialogue appends legacy JSON-only workflowInstructions.
- Native frontend defaults missing interaction to other; classificationBatch then skips it.
- Asset confirmation requests bilingual text and persists the entire reply as a generation prompt.
- Native document tools have existing versioned drafts and creator approval guards. Visual profiles/shots have separate direct APIs and version fields to reuse.
- Text provider requests have configurable templates; structured-output currently only extracts JSON and applies Zod. Introduce explicit capability options without changing existing default provider behavior.
