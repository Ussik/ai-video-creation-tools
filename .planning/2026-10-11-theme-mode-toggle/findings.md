# Findings

- main.tsx uses MantineProvider defaultColorScheme=dark; Mantine already supports persistence.
- theme.css defines global fc tokens and workspace/canvas/select/creation aliases for body portals, but fixes color-scheme to dark.
- Components largely consume tokens; remaining fixed UI colors concentrate in project-canvas.css, script-director.css and workspace-theme.css. Preserve media backgrounds and preview art.
- Desktop footer contains workspace status and collapse control. Collapsed navigation is 64px wide. Mobile uses Mantine Drawer.
- Extensive uncommitted work exists. Main theme/navigation baseline copies are in /tmp/ai-video-theme-baseline.

- A late project-canvas rule defines canvas-chrome-surface=#17191b locally; it must also change with the light palette.
- Canvas occupies the full viewport and intercepts the hidden main sidebar. Use its visible return-project button for navigation during QA.
- A preexisting/concurrent canvas version conflict appeared during browser QA; closed the prompt without merging or saving.
- Theme CSS updates must settle before computed-style checks; screenshots immediately after edits can reflect the previous stylesheet.
