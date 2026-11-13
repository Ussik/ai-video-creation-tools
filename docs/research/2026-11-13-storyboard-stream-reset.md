# Storyboard initial-generation stream reset

The screenshot task `c41e9d76-8f9a-4d6f-b064-583c3f4342f6` failed in initial generation after 457292 ms, following 45197 ms of preparation. The saved provider error is `stream_read_error`, with HTTP 200 upstream SSE reporting `connection reset by peer`. Its last attempt lasted 80.5 seconds and delivered only 494 visible characters. Only skill rules and preparation were checkpointed; there was no complete candidate. The transport already performs one bounded retry, so adding another blind whole-plan retry would not address lost work.

The selected native Anthropic model uses configured medium reasoning. The prepared storyboard and motion rules total 61215 characters. Initial generation previously combined both sets with all source and context, then asked for the full scene, production prompts, audio and detailed camera/cut metadata in one response. Structured JSON Schema was also duplicated in prompt text when native schema format was active.

## Change

Long or larger plans now generate a complete compact outline first, with scene direction, narrative beats, shot identities, duration, speech allocation and cut boundaries. The outline request carries storyboard rules; motion rules are added for shot expansion. Each subsequent response expands at most two shots with image/video prompts and directing metadata. Expansion cannot overwrite outline facts or timing. Complete batches are checked, compiled and retained independently; an incomplete upstream response remains diagnostic text only.

Checkpoint identities include initial/repair namespace, both prompts, both schemas and the validated outline hash. Restored values pass validation again. Final assembly still uses full compilation, source validation, exact scene/shot timing, shot identity checks and director review. Reestimation always takes this path, including a historical two-second scene whose proper duration is 90 seconds. Short single-scene work can retain direct generation to avoid unnecessary requests.

Native Anthropic schema mode now omits only the application-generated schema prefix using internal object identity. The original full prompt remains available for unsupported-native-format fallback. Creator content, model configuration, reasoning and existing retry limits are preserved.

The UI shows outline preparation or completed/total shot count. Partial batches remain unavailable for preview/save. Failed tasks retain their count and can explicitly continue from unfinished batches. The screenshot task input identity remains compatible with the new path.

## Evidence and limits

Planning, batching, task and route regressions passed 112/112. Provider and adjacent storyboard regressions passed 103/103; frontend task and planner tests passed 57/57. The full build passed. Independent review found and closed the historical-duration reestimation gap, then confirmed the change. Tests cover initial and repair interruption, bounded transport retry, malformed/partial response rejection, saved checkpoint revalidation, scene/index mismatch, locked fields, source dialogue, final compilation and absence of formal project writes.

The original local task was inspected read-only and remains resumable. No paid model request was issued and no production task was resumed or altered. This repair reduces response size and the amount of work lost on failure; total latency and real gateway reliability have not been measured. More bounded requests may increase request overhead. It cannot prevent an external gateway from resetting connections.
