# Findings

App studio duplicates the full generation subsystem: models, modes, references, prompts, preview/submit modal and previous-tail local handoff. Existing trimming and source audio already patch timeline-clips. Candidate selection, cut review, production range and export are distinct useful workflows. requestVisualCanvas opens visual bindings, not shot-node focus; per-shot navigation must search project canvases.

Canvas drafts use project-canvas-draft:<project>[:<canvas>]. Existing graph loading honors drafts and handles conflicts, so shot lookup must inspect drafts before remote graphs. Default empty canvas imports all shots automatically; targeted navigation must mark that attempt to prevent importing unrelated shots. Existing initial viewport animation must defer to requested shot focus.

Desktop isolated browser fixture at 1440x1000 shows the new three-column workbench: ordering rail, media/cut review in center, dedicated trim/audio/output inspector and fixed timeline. No visual overlap in populated state; actual generated local six-second test video loads. Browser TaskSpace 25 created for this task and remains active.

Responsive QA found legacy fixed viewport height and flex shrinking at mobile 390px, causing inspector/timeline overlap and content overflow. Scoped final-cut CSS now uses height:auto and non-shrinking panels with visible center overflow. Tablet output is aligned below shot summary alongside trim/audio, rather than after a large empty gap.
