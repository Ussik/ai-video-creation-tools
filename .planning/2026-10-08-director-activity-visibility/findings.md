# Findings

- LibTV task space 125. Supplied project loads an empty workspace and no existing conversation history.
- Selected 古典武侠电影全流程导演 Skill and sent one discussion-only test (rainy inn, 30-second story, two directions; no document/node/media writes).
- Existing app process events have label/summary only. Frontend merges repeated labels and truncates to eight entries. Not rendered while pending. Server conversation storage drops activity entirely.
- skillContext already exposes active Skill IDs/names/revisions and loaded Markdown files. Native tools have meaningful labels and summaries but no invocation IDs, status, arguments/result detail or durations.

- Actual LibTV test shows public per-step commentary (load Skill, inspect canvas/project, recover from a rejected parallel query), status rows for searching and no results, interleaved thought-details controls, then story directions and explicit confirmation items. We implement real app-operation trace and public results without exposing hidden thoughts.
- Added shared dependency-free activity types, per-operation recorder, Skill-specific loaded file metadata, native model/tool round events, and JSON fallback trace. Added an activity database migration and shared frontend history serializer.
- Long tool argument/result previews explicitly limited to 4000 characters; original model tool inputs and results remain complete. Trace details never enter subsequent model conversation messages.
