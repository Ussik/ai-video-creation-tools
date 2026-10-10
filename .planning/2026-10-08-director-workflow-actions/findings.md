# Findings

Current stage recommendations are duplicated in frontend and backend. Readiness proposals must come from an explicit native tool and be validated against current saved documents and pending drafts, with a version/state key to reject stale actions. Existing progress functions are retained for compatibility and backend authority exposed through tools-state.

Implementation keeps initial direction readiness in a model proposal with real creator-message references; no fixed genre/character checklist. Saved non-outline stages can be recommended deterministically. The proposal version hashes original documents, scenes, settings, decisions and draft state. Stage buttons submit that proposal id for validation; manual explicit stage selection stays available. Generation and confirmation saving remain separate.

Accepted revision proposals become scoped document_action requests, with original-version checks and read-before-patch protection. Natural-language creation independently verifies that the creator asked to generate the target; an explicit stage button already carries that intent. Clear proposal on new dialogue, suppress next actions during questions/drafts, and guard async refreshes against newer SSE results. The existing Skills injection, trace persistence and timeouts remain in both ordinary and typed-stage tools requests.
