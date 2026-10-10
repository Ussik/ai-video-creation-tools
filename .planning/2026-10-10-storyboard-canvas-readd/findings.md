# Findings

- Default frontend selects up to10 unplanned scenes. With24-scene projects, this fills the batch and disables every unchecked saved scene, matching the screenshot.
- Canvas deletion only removes canvas nodes and edges; shots, plan requests, assets and bindings remain. Backend saved imports are already repeatable and model-free.
- Import helper recreates missing image generation nodes and deduplicates by shot identity, but currently leaves restored nodes asset_id:null even when the shot selected image exists.
- Proposed fix: expose per-scene persisted image-node coverage, prioritize missing saved nodes, add clear/missing/planned/unplanned batch controls, and restore image assets only on fresh nodes.
