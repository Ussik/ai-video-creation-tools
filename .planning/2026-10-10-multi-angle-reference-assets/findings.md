# Findings

- Baseline push succeeded: 67c46a6 on main at Ussik/ai-video-creation-tools. Frontend 324 tests, backend 299 tests, both builds passed.
- Current visual profiles have one approved board, candidates and revision/style metadata. Shot visual bindings already freeze definitions and board IDs. Video references use an ordered shared manifest with exclusions and API role validation.
- Missing capability: independent angle/purpose images, per-shot selection of them, and persistent handoff to video. Seedance official guidance favors clear single-person face/full-body references over tiny-face multiview boards.
- Actors: backend asset/snapshot implementation; profile UI implementation; root coordinates shared request and canvas integration. Shared plan owned only by root.

- Metadata is shared in visual-reference-types.ts. reference_assets on a profile includes mutable review state, while shot reference_assets stores only approved immutable snapshots. Signature checks include the selected set.
- Skills read parsed shot choices and exact submitted reference metadata; no unsubmitted reference is appended into their numbered mapping. Director read tools also require the new asset-aware status.
- All existing image/video modes retain old-board fallback. Imported shots with independent refs must not create unused old-board nodes.
- Archive affects new selection, not historical snapshots. Existing retained entry IDs must resolve from the frozen metadata, while new entry IDs require confirmed/current assets. Completed independent bindings must be excluded from both unresolved-board fill and draft-definition propagation.
- The old RESTRICT→CASCADE rebuild explicitly copies columns; it must preserve optional board-style and independent snapshot data when those columns are already present.
