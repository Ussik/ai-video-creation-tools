# Findings

- Current strip has a distant label on the far left and a name-only dropdown on the far right. It consumes full modal width while configuring only the next planning request.
- Existing CreativeSkillSelector already supports primary/auxiliary selection, temporary selection, project/global default saves and planner appearance. Reuse it with a compact “更换” trigger.
- Preview result includes actual used_skills and source_documents, so its summary should use these instead of current selection. Saved-only preview has no recorded usage metadata and should not claim a skill was used.
- Default source can be derived by comparing the selected ordered IDs with policy primary_id/auxiliary_ids; a mismatch means “本次选择”.
