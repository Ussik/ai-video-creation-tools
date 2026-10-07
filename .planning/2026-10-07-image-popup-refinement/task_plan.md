# Image parameter popup refinement

Goal: Keep the image parameter popup compact and provide the complete preference set requested in the latest reference.

- [x] Confirm the source of disabled options and current model capabilities.
- [x] Render the complete quality, clarity, background and ratio set requested in the reference.
- [x] Tighten popup dimensions and option tiles without harming keyboard/focus states.
- [x] Verify current model interaction, persistence and responsive layout.

Decision: The user's latest reference requests all five quality levels, three clarity levels, three background modes and thirteen ratios. Model-native fields use configured templates; other preferences are included in the actual prompt. Preserve the provider's configured API sizes and display them during submission review. Do not infer native capability from a generic starter configuration.

- [x] Restore all reference controls with defaults and independent selection state.
- [x] Carry every selection through the request or fallback prompt, retaining configured native values.
- [x] Verify full panel interaction, submission review, persistence and responsive layout.

Verification: 23 targeted frontend tests passed, 18 provider/canvas backend tests passed, frontend production build passed, and `git diff --check` passed. Ego Lite confirmed all reference controls are selectable, the confirmation view keeps `extreme / 2K / transparent / 16:9 / 2张`, and the actual prompt carries unsupported native preferences as explicit image requirements. Reload retained these choices. The complete popup is 320px wide and approximately 562px high; the 390x844 screenshot shows all groups within the viewport without horizontal overflow. Cleanup loaded a newer server canvas version and preserved its choices, discarding only unsaved local QA changes.

Errors: Existing worktree contains unrelated user changes; preserve them. The request review was closed without submitting a generation task; no paid generation requests were submitted.
