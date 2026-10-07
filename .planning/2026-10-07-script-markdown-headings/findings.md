# Findings

- Screenshots show compact Chinese headings such as #全剧故事大纲 and ##项目信息 displayed literally in both editor and canvas.
- parseScriptDocument requires whitespace after one to three hashes. The editor already uses this codec; compact headings remain paragraphs.
- ProjectCanvas passes original Markdown with a parsed document to CanvasTextPreview. resolveTextDocument only accepts the document when its plain text equals the text argument, so successfully parsed Markdown is discarded. Other script previews already pass textDocumentText(document).
- Existing Markdown persistence supports H1-H3, marks, lists and quotes. No schema migration is needed.
- Existing frontend/backend servers listen on 5173/8000; do not restart them.
- Confirmed live project headings render as H1/H2 in canvas (28px/23px) and editor (23px/20px), with no remaining compact-heading paragraphs. The editor remains saved on opening. Screenshots: /tmp/outline-heading-canvas-fixed.png and /tmp/outline-heading-editor-fixed.png.
