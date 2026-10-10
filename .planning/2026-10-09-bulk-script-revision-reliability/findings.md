# Findings
- Screenshot error was changes.max(8), not original-text mismatch.
- A pending draft blocks subsequent batches; read versions/ranges are session-local.
- Preserve exact replacement, atomic save, project scope and source versions.
- Existing professional review supports originals only; bulk verification needs actual draft coverage.
- Loop permits explanatory final text after recoverable failure; generic Zod errors obscure repair.

Task metadata fits existing JSON draft storage, no migrations. Proposed decisions adopted only inside atomic commit. Final review is semantic model assessment validated against full effective draft reads and exact evidence; markers are only hints. Sources and reference snapshots are checked again on GET/commit; stale reviews reopen task.

Final review snapshot now binds the entire draft group and canonical project context; editing any document/decision/confirmed constraint invalidates cross-document review. Atomic save regression injects a mid-save SQLite failure and proves rollback of every document, decision and report. Committed task review also updates document-health reports; keyword hints cannot override a current professional report.
