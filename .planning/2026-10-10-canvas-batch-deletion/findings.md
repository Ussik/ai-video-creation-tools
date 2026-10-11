# Findings

- Existing selection supports Shift box selection, modifier-click and Delete/Backspace.
- openContextMenu collapses multi-selection; current context/sidebar delete supply a single node ID.
- changeGraph snapshots history, removes attached edges and autosaves a graph update.
- Document pointer capture clears selection outside nodes/menus/overlays. New controls require data-canvas-overlay.
- Shortcuts skip input/textarea/select/button/contenteditable. Select-all additionally needs canvas scope.
- canvas-refresh-stability.test.tsx mounts actual React Flow with JSDOM geometry/ResizeObserver. Reuse for behavioral regressions.
- Workspace has unrelated edits, including ProjectCanvas.tsx; preserve them.

- React Flow suppresses onPaneContextMenu when right button (2) appears in panOnDrag. Changed panOnDrag to left/middle; right click now opens menus.
- Box-selection right-click lands on React Flow selection overlay, not on an individual node; added onSelectionContextMenu forwarding to batch menu.
- Clear-canvas suppression is recorded in existing project-canvas-imported key and session ref, including deletion of the last node.

- Real browser pointer-down on React Flow's selection rectangle used to clear selection through document capture. Whitelisted actual selection overlays; a real Shift-box-selection JSDOM test now verifies the full pointer-down/context-menu sequence.
