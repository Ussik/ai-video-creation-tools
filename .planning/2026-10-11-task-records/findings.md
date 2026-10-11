# Findings

- Task history lives inline in App, four columns with no filters. Shared header speech condition includes jobs.
- Existing JobInformationPopover has prompt, parameters, reference assets and full error; reuse it.
- Project poll is sequential every 4 seconds and shared with canvas. Gate polling using refs rather than remounting project effects.
- App's preview modal supports images, videos, audio and text; result buttons can open it.
- Retry endpoint rejects speech retry and unsafe image regeneration. Preserve recovery_available and task_resume_available behavior.
- Existing working tree includes many changes and recent project switching/asset presentation work. Apply narrow edits and compare against local baseline.
- Existing billing-check branch hid the continue-query action for resumable asynchronous image jobs. Respect task_resume_available before manual billing review; continuing an existing job does not resubmit paid generation.
- Browser TaskSpace 37 / p1 connects and loads live app at http://127.0.0.1:5173. Use only read-only browsing and local UI interactions.
- Browser type selector works through ArrowDown and option selection; combination of failed/image/search reduces 47 tasks to one. Clearing filters restores all 47; existing video result opens in-page player without navigation.
- At 390px, task rows adapt to stacked layout. Task and header bounds stay within viewport; a document overflow flag requires checking non-task nodes.
- Delay task-entry refresh until detail is loaded to preserve initial project's selected-shot setup when switching project on task history.
- Document width settles to 390px after viewport layout, with no overflowing nodes; tablet task bounds also fit at 768px.
- Concurrent working-tree additions of ThemeToggle and JobQueueControls were observed during this task and preserved. They are outside this task's implementation scope; latest build includes them.
