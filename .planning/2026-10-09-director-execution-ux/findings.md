# Findings

- Existing execution panel is a flat chronological trace with model, context, Skill and tool records mixed together. It expands during pending requests and collapses all steps at completion.
- Default header uses Skill/function counts. Useful document/source titles are hidden in payloads or free summaries. Raw inputs/outputs appear inside each step.
- Message metadata stores classifications and reviews; add bounded task/result metadata to persist actual outcome and target scope.
- Existing draft confirmation/edit/restore and regeneration functions can supply actions. Retrying arbitrary tools could repeat writes; only read-only failed turns should offer direct retry.
- Project UI uses neutral dark grays, subtle borders, 14–20 px panel radii and existing Lucide icons. Keep these conventions and focus on hierarchy, readable statuses and progressive disclosure.
- Read source labels survive raw JSON truncation through independent bounded target metadata; legacy fallback accepts complete valid payloads only. Duplicate object reads and Skill loads count once while every invocation remains in details.
- Recovery can use exact draft IDs from public function results or commit parameters. A preexisting pending draft must not turn a failed discussion into a successful draft task or reopen an unrelated preview.
- Source navigation must show saved source text when a pending draft shadows the same document in the document library.
- Browser QA showed bottom-of-log follow scrolling hid the task header behind trailing deliverables. Following the latest message now excludes those trailing cards.
