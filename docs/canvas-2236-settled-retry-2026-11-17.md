# 22:36 visual-profile contract failure and retry recovery

Implemented directly in `/Users/caoyanzu/workspace/ai-video-creation-tools`, branch `main`. Existing edits and business data are retained. No commit or push.

## Incident evidence

Task `b18571a0-19bc-452a-b088-a18c317552fa` returned HTTP 200, complete text, end_turn, no tools. Provider usage reported 171595 input tokens and 2973 output tokens. This was a complete contract failure, not a disconnect. The original and explicit-retry candidates used object-valued `view_requirements`, `usage_type` instead of `usage`, custom view enums and, in the retry, extra row fields. Native Anthropic output_config.format schema was requested, but gateway enforcement remains unverified. Selected skill files did not contain those exact conflicting field examples, so their presence is not evidence for attributing these aliases to skill text.

The historical assembly included whole-world/constraint and broad episode subtrees. The one-shot retry marker prevented further explicit attempts after another complete failure. Some local Zod failures lacked a stable contract error code and became unknown recovery. The UI labeled non-actionable states indiscriminately as irrecoverable.

## Changes

- A durable bounded chain permits the initial attempt and at most three explicit follow-ups per object, still subject to existing task budgets. Complete settled failures alone authorize a next token. Duplicate intents reuse retained results; every prior response and receipt remains unchanged. Malformed histories and newer unresolved attempts block dispatch. Status reads can upgrade old one-shot recovery metadata without rewriting private checkpoints.
- Each attempt permits one local correction. Parseable rejected content is retained as the next explicit attempt's seed so only its fixed failed-field patch needs a new provider request. Valid fields stay in the application closure, outside correction targets. Locked identity/base/delta conflicts cannot be overwritten.
- The only local field alias migration is usage_type to usage when usage is absent and the alias already belongs to the canonical enum. Its source/candidate hashes are audited. Conflicting aliases, object-valued prose and custom views are not guessed or defaulted.
- Rows with extra fields require source-bound semantic adjudication for every extra key. Legal row fields are literal-locked. Original notes/priority and correction bytes remain available; the application does not silently strip them to manufacture a valid response. Adjudication is a model judgment, not a deterministic proof of preserved meaning.
- Fresh object requests use schema-derived content instructions, named source records, standalone character facts, general prohibitions, project style, required base/current profiles and the full selected scene/shot evidence. Unrelated world/episode material and format examples are excluded. Historical prompts remain solely for exact paid-response binding; upgrading the prompt does not create a new original request.
- A successful selected base releases its blocked descendants while completed siblings are reused. UI labels distinguish pending delivery, exhausted attempts, budget exhaustion and a candidate needing attention.
- Safe transport diagnostics expose actual input character counts, local token estimates and native-schema hashes/presence to observability. These values contain no raw prompts or keys.

## Verification

- Relevant backend: 125 passed, 0 failed, 1 skipped. The skipped case requires an optional private legacy fixture; both anonymous captures of this incident were replayed successfully.
- Frontend: 111 passed, 0 failed, including API-to-React recovery integration.
- Build: architecture guard, UI guard, shared/backend/web production builds passed. Existing Vite large-chunk warning remains. git diff --check passed.
- Regression reproduced before its fix: a newer patch disconnected after an older settled explicit failure; recovery status resurrected the older retry token. It now remains non-actionable after status refresh/restart, with no repeat dispatch.
- Broader Anthropic suite: 53 passed and 4 failed. An isolated archive of committed HEAD reproduces the same four pre-existing failures (51 passed, 4 failed). Those tests expect unsupported-native-schema automatic fallback, while the committed strategy explicitly prohibits hidden fallback. This task does not change that strategy.

## Actual-source transport capture

A read-only SQLite backup and a private temporary copy of its local encryption key were used solely in a disposable directory. Global fetch was replaced before application import; every request was intercepted locally and returned HTTP 400. The temporary database/key were removed afterward. No production checkpoint/budget/run was changed; no upstream request was sent.

The actual source and model configuration yielded a legal retry action in the isolated recovery snapshot. Its final Anthropic patch body included repairs and field_adjudications schema fields, no tools, and no old usage_type instruction:

| Measurement | Value |
| --- | ---: |
| Actual transport input characters, including schema | 47339 |
| Conservative local estimated input tokens | 51971 |
| Complete selected scene/shot evidence characters | 18772 |
| Creative/style rule characters | 9127 |
| Selected object fact characters | 874 |
| Current/base profile context characters | 28 |

The historical 171595 is provider-reported usage; 51971 is a conservative local estimate for a new local patch. These are different request types and counting methods, not a controlled provider-token reduction measurement. Native schema presence does not prove gateway enforcement. No live-model success claim is made.
