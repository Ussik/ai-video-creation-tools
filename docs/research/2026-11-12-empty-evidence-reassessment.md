# Empty evidence reassessment

The scene-design task failed because the model returned an empty `reassessments` array even after its one format correction. The retained review contained four issues, so an empty response could not complete the review or withdraw any finding.

The reassessment prompt embeds the original review task for its acceptance criteria and factual context. That task permits an empty `findings` list when there are no problems. The reassessment protocol now explicitly distinguishes each original issue's disposition from a list of remaining problems. Even if every issue is unsupported, the model must return one reasoned `withdrawn` decision per issue. The same instructions accompany the existing format correction.

The response schema now restricts IDs to the actual issue set and requires exactly that many decisions. Duplicate IDs, missing reasons, unsupported sources, invalid ranges and unresolved decisions retain their existing validation. Empty or malformed responses never become successful reviews, and semantic pending checkpoints remain resumable.

Validation: 136 related tests passed, including empty-output correction and repeated-empty continuation cases; backend TypeScript and architecture checks passed. Independent code review found no blocking issue.

## Recovery validation

Project: `17a81aaa03b8474ca59a07c485bc759c`. The original four scene-design candidates were retained in full and contained no truncation marker. Two local review groups had already passed; the retained global reviewer incorrectly described candidate bodies as missing or truncated.

A service restart interrupted the first recovery attempt. Separately, a newly added `rules_only` skill integration annotation changed both the task recovery key and generation identity. A fresh request therefore began generating again and was stopped.

Before migrating retained work, the old and current generation identities were independently reconstructed and their hashes matched their database keys exactly. Their prompts differed only by the known 203-character integration annotation; the manuscript, saved documents, scenes and existing tool drafts matched the pre-recovery snapshot. Using the existing generation checkpoint store, the old complete prompt and all step hashes were copied to the current identity. The archived original remained intact. The subsequent normal continuation reused all four original candidates.

Recovery task `4fb696de-3fa2-4df3-9356-459d640f01c1` completed real local and global review and created pending draft `6234ff5126d84b3d8f72eac19ab9eded`. All four documents match the retained candidates exactly in type, title, order and UTF-8 content. The manuscript, source document, eleven formal artifacts and zero formal scenes are unchanged. The draft remains pending; no save was performed. The empty-response correction itself is covered by the regression tests; this recovery completed through the fresh review path.
