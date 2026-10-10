# Findings
- RevisionProgress in DirectorDocuments is a full card outside message scroll when live, so it permanently takes space from the conversation. Agent owns its compact disclosure implementation and CSS.
- ScriptDirectorPanel auto-resizes textarea and observes editor/question height. New composer wrapper must be observed when collapsed and autoresize must rerun on reveal.
- Current skill row sits outside textarea editor. Move it into the composer header beside collapse icon so the collapsed area hides both.
- Preserve busy chat stopping, unsent draft text, references and prompt editor. Explicit reference/revision actions should reveal before focusing.
