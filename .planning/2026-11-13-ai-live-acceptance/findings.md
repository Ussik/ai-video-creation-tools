# Findings

- User authorized representative real AI integration acceptance after Langfuse setup; small actual model spend is implied and disclosed.
- Branch codex/langfuse-observability at30c1017 clean. Existing official serviceports8000/8888 preserved; isolatedbackend8002 selected.
- Use only providers/models/speech_config and local encryptionkey copied from read-only sourceDB. No projects/jobs/media are copied or modified in original.
- Do not infer upstream reliability from former fixture tests. Confirm actual dispatch/result and exact local trace IDs; destructive fault injection belongs only to isolated fixture tests.
- Current path /Users/caoyanzu/.codex/worktrees/ai-reliability-implementation/ai-video-creation-tools. Actual current config/stages verified from source.

- Real sample: GPT Responses script succeeded in 11.78s; one scene12s persisted. Anthropic controlled_storyboard failed after two full responses with invalid scene_direction keys and empty ending carry_over; failed candidate was not saved and task can_resume=true.
- Image, video, TTS all succeeded. Actual files fully decode: PNG1254x1254; H264864x496/4.04s; MP324kHz/2.256s, provider usage11characters. Media identical submission replay returned same job; storyboard request replay returned same task.
- Acceptance exposed media usage request counters omitted auxiliary dispatches, and successful TTS terminal-frame cancellation caused a false ERROR child in Langfuse. Fixes in progress.
- Five real traces/34observations initially read back from Langfuse. No prompt/output/credential content present. Failed storyboard correctly visible as failed; initial TTS false child retained as original evidence.
- Existing recovery fixtures48/48 passed. Speech/auxiliary/exporter targeted checks33/33 passed after validated completion fix.

- Original storyboard resume completed its two bounded requests but still failed: full JSON contains unescaped ASCII quotation marks in cut_note. No candidate, no independent review, no save. No additional paid retries were dispatched.
- Final accounting found inherited HTTP usage ALS duplicated durable storyboard counts into admission/resume records. Fixed only durable launch scope; regression preserves ordinary nested budgets and tests route acceptance/failure/resume. Historical rows not migrated.
- Final real attempts: 9 generation requests (5text,2media,2speech),21poll,2download. Actual text usage34413input+23721output=58134tokens; independent Langfuse7traces39observations confirm.
- Final code: backend3267/3267, complete unified build passed. Isolated8002 app stopped after task settlement; original8000PID44349 and8888PID49505 preserved.
