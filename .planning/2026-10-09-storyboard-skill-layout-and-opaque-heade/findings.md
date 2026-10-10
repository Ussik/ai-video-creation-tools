# Findings
- Skill selection occupies a full section between references and requirements; move to compact row directly below model/shot-count configuration.
- Header explicitly has transparent background. Single-class content CSS can lose to later Mantine base styles, permitting outer scrolling behind sticky header.
- Raise content specificity; keep opaque header separate from flexible body/internal scroll. Shared modal shell also used by StoryboardCanvasImport.
- Reuse chat appearance and allow downward/end placement for selector near top of dialog.
