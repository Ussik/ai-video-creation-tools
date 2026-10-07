# Findings

- Existing handoff calls script/convert-to-shots and creates one shot per scene with text only.
- Canvas collects reference_asset_ids from incoming nodes and already supports configured image-reference templates.
- Asset tasks support character/location/prop generation and source scenes/artifacts but have no individual subject identity, approved board or written specification binding.
- Script scenes store character/location/action text; props require semantic extraction from script documents/action.
- Existing canvas data is saved with optimistic revisions; new automatic references must preserve manual graph edits.
- Baseline: main c8cac2a pushed to origin; frontend 121 tests, backend 91 tests and both builds pass.
- Generation preview shares submission validation, appends frozen written specifications and boards, and records a signature that detects changed/removed bindings before enqueue.
- Retained shot bindings preserve their snapshots during unrelated binding edits; refreshing a version requires an explicit profile ID.
- Optional Zod fields with defaults can still apply defaults in PATCH; variant is overridden without a default.
- UI verification will use mocked data and actual React components in a temporary Vite fixture, avoiding real project mutations or paid model calls.
- Browser confirmed draft editing/save with zero generation calls. Select dropdowns need z-index 450 above the preparation modal; delete confirmation likewise needs a higher dialog layer.
- Full initial suite passes: 96 backend, 121 frontend. Added one local mock-provider integration test; all six visual profile tests pass.
