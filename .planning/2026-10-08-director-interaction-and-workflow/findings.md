# Findings

- Screenshot duplicate next-stage button originates in saveGenerated: nextStage is hardcoded array index + 1, ignoring already-saved characters/locations/props.
- Existing stageIndex also infers locations from generic scenes or structure documents, so missing stage selection can be inconsistent.
- Writer supports choices/input_request only; ordinary prose is classified by another model call, version 6 cache. Confirmation-only requests have no dedicated contract.
- Recognition only processes <=8,000 characters and <=40KB per batch, silently skipping longer replies.
- Choice fallback only allows original explicit alternatives, making implied yes/no hard to render.
- Existing status/context cache avoids reopening old answered questions; preserve it and expand to all new interaction types.
- Existing panel caches answer/dismissal by message ID; multi-question handling needs item identity and local progress without advancing conversation after each incomplete item.

- Post-save recommendation now derives from the commit endpoint response. Quick actions use saved project progress instead of the manually selected stage, preserving explicit stage controls. Legacy scene/structure documents no longer masquerade as location design.

- Browser verifies an ordinary >8K reply is classified into three distinct confirmation/input/choice items, and Next causes no writer call. Reload returns the app to its project list, so QA must reopen the project/director before checking retained answers; an initial field wait timed out for that reason.
