# Prop review context order and continuation

## Observed failure

Project `17a81aaa03b8474ca59a07c485bc759c`, task `d8379c49-9516-463e-891c-5502b140f581` retained four complete prop candidates (13,660, 7,646, 11,920 and 17,212 characters). Both local reviewers incorrectly reported missing candidate bodies after looking in `saved_documents`. Semantic reassessments then reported that the original issues were absent, although those issues were retained and included in the request builder.

The current HTTP Anthropic Messages path does not trim prompt strings. A mock transport check preserved a long prompt and its final issue/source markers exactly. Actual reassessment requests were approximately 642–645 KB, with the upstream reporting approximately 273–276 thousand input tokens. The model did not correctly locate the supplied material; these observations do not establish whether the upstream service changes input after dispatch.

## Changes

- Present the current candidate bodies before the complete historical background, explicitly distinguishing pending candidates from `saved_documents`.
- Present original issues and numbered candidate sources before the complete original review task during semantic reassessment. Preserve the full context and explicit per-issue disposition contract.
- Persist unresolved issue IDs bound to the current retained report hash. Following a mixed result, continue only those issues; confirmed findings retain their semantics and evidence. Remap IDs after withdrawals. Old boolean or invalid state safely falls back to reviewing the retained report.
- Unresolved decisions, invalid output, cancellation and provider failures remain incomplete. No automatic withdrawal or acceptance based on wording is introduced.

## Validation

Targeted evidence, reassessment, history, scope and recovery regressions passed. The migrated generation-resume, native recovery, source-outline and completeness integration tests passed, including the previously timing-sensitive case in this run. Backend TypeScript, architecture and scoped whitespace checks passed. Independent code review found no blocking issue. Test logs: `/private/tmp/props-review-evidence-final.txt`, `/private/tmp/review-prompt-layout-unit.tap`, `/private/tmp/review-prompt-layout-integration.tap` and `/private/tmp/props-review-regression.txt` (its one outdated assertion was corrected and the affected file rerun successfully).

The affected task was resumed through its normal local continuation endpoint using its original model configuration. All four candidate-generation steps were reused. Both local reviews and the independent global review completed; the task now has status `succeeded`, no error event, and a normal two-item draft resolution (`18402e92bade4f7e8f9df7cd8f93f931`). The missing-input false positives did not recur. The actual remaining issues concern omitted prop appearances and an unrelated skill-example prop included in the candidate. They were retained for normal creator-directed handling rather than silently withdrawn or rewritten.

An independent read-only comparison against `/private/tmp/props-review-20261112-before.json` verified all four complete candidate objects, their titles, contents and requested order in the resolution. The uploaded manuscript, scripts row, fifteen formal artifacts, zero formal scenes and all three historical saved tool-draft rows are unchanged. No new tool draft was saved and no formal document was published.
