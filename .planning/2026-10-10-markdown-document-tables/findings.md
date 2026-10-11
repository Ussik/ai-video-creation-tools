# Findings

- Screenshot tables are raw GFM pipe lines, not real tables.
- parseScriptDocument supports headings/lists/quotes but no tables.
- ScriptEditor and search use a canvas schema without table nodes.
- DirectorDocumentBody uses CanvasTextPreview, whose renderer lacks tables.
- Script content persists as Markdown. Keep canvas schema unchanged and add script extensions.
- normalizeTextDocument drops cell attrs; preserve supported alignment for script tables.

- Official table 3.31.3 already supports align attrs and wrapper; no custom table node implementation needed.
- A higher-specificity reader paragraph rule added 18px cell bottom margins; table-scoped rule now overrides it.
- Browser desktop editor table: 678px, 3 columns, long text wraps. Review panel: 369px local viewport / 480px table.
- 320px review: panel client/scroll widths both319px; table viewport269px/scroll480px, no panel overflow.
