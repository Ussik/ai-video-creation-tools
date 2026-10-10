# Findings

- StoryboardPlanner saves professional shots and directly calls storyboard/canvas; it never calls the existing script/canvas preparation chain.
- canvasResult includes only profiles already bound to shots. Fresh scenes without scene bindings import zero reference profiles, and no-binding image generation proceeds as text-to-image.
- Existing preparation check/prepare/commit supports versioning, incremental reuse, visual_assets skill and required scene/shot bindings.
- Canvas already supports profile nodes, automatic reference/dependency lines, required missing-reference checks, candidate confirmation and missing-node navigation.
- Canvas handoff currently prioritizes first shot even when reference nodes lack confirmed boards. It should prioritize a required missing reference.
- A scene preparation fingerprint must include the planned visual content, or replanning could introduce a new visible object without updating references.
