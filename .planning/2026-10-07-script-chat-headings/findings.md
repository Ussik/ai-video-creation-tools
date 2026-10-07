# Findings

- `ScriptDirectorPanel.tsx` renders assistant messages through `DirectorMessageText`, which calls `parseScriptDocument` and `CanvasTextPreview`.
- `headingPattern` in `web/src/script-rich-document.ts` recognizes compact headings only when the first character after `#` is Han.
- The screenshot message begins `##20集...`: the first body character is a digit, followed by Chinese text, so the whole line remains a paragraph and the hashes are visible.
- Existing regression tests require `#tag`, `#123`, and inline hashes to remain literal.
- Numeric compact headings now share heading parsing and block-boundary recognition with Chinese headings. Serializer escapes literal numeric Chinese heading markers before reloading.
- Actual chat preview renderer produced `<h2><span>20集暂定总体结构</span></h2>` and preserved inline bold, confirming the same path used by DirectorMessageText.
