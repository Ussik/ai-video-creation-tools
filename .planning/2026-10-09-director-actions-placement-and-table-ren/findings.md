# Findings

- The storyboard selector was below model configuration and used the warmer chat popover surface. A scoped planner appearance avoids changing the approved script selector.
- Next-step navigation was fixed outside message scrolling and counted as composer height. It now belongs after conversation results; the observer measures only the fixed input area.
- Two adjacent chevrons meant different things. Collapse now uses a panel icon with visible “收起” text; expansion uses the matching panel icon and label.
- The existing rich document schema has no tables. Installed react-markdown and remark-gfm render read-only messages without changing editable document storage.
