# Findings

- User screenshots identify two video-generation placeholder quick actions and the existing bottom mode menu.
- CanvasGenerationControls already owns videoModeLabel and the desired 首帧承接 / 首尾帧 names.
- ProjectCanvas quick action currently changes only mode; bottom menu also changes visual_reference_mode and pins the opening storyboard.
- Repository contains substantial pre-existing changes; preserve them and limit work to ProjectCanvas plus a behavioral integration regression.
- No applicable AGENTS.md found in ancestors or project.

- First-frame pins the same-shot storyboard even when an unrelated image was connected earlier. First/last-frame preserves explicit connection order. Both paths produce identical preview requests and retain manually edited action prose.
