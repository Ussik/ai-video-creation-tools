# Findings
- VisualPreparation is used by canvas sidebar, composer, derived edges, missing references and inspector, plus legacy App shot editor.
- Canvas already handles generation, upload, references and candidate confirmation.
- Backend has creation, editing/deletion, scene/shot bindings, snapshot refresh and apply-to-shots APIs. Deletion is disallowed when shots use the profile; expose references to resolve this.
- Batch analysis returns editable unsaved drafts. Preserve review before saving.
- Shot snapshots can change board/style versions without a definition revision change. Focused manager compares all three and retains boolean-normalized other bindings.
- Read-only inspectors adopt newer revisions automatically. Dirty edits retain their original expected revision and can explicitly load latest with a discard confirmation.
- New component + related regression suite passed 45/45 before final revision-refresh refinements. No backend mutation logic changed.
- Browser verified successful edit increments profile revision and opens profile-scoped usage panel listing scene and shot. Screenshot shows no overlay backdrop; native fields, checkbox states and snapshot refresh are visible alongside canvas.
- Backend canvas saves reject references to deleted profiles. Removing a definition must also prune its nodes from current graph and undo/redo snapshots; otherwise Undo could reintroduce an invalid profile. Implemented pruning while retaining other canvas layout history and original assets.
