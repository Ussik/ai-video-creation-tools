# Findings

- ReactFlow currently mounts all nodes; no onlyRenderVisibleElements setting.
- StudioNode is not memoized; flowNodes recreates data/options/callbacks on graph or selection updates.
- Every selected text node mounts a rich editor, making multi-select expensive.
- Dragging already records one history entry and saves at the gesture end. nextNodes still loops all changes for every node and repeatedly scans group membership.
- NodeMedia loads original images and video metadata; no known thumbnail API yet.
- Backend limits one canvas to 500 nodes / 1000 edges; multi-canvas support already exists.
- Existing refresh stability tests instrument actual preview renders and assert unchanged refreshes do not mutate/save graphs.

- Baseline browser dev build:100/300/500 nodes mounted100/300/500; all-select created50/150/250 rich editors; React durations129/249/407ms. Test fixture uses long text, image and generation nodes, no real project writes.
- Existing project refresh shares unchanged entities via shareProjectSnapshot; preserve that contract.

- After optimization, the same normal viewport mounts 6 cards and 2 images for each 100/300/500-node fixture. Selection toolbar retains the full graph count and creates zero rich editors on select-all.
- At overview zoom, 99 visible cards mounted without rich previews or images; handles remain. Very tall graphs reach the existing 10% minimum zoom, so fit-all does not guarantee every node fits onscreen.
- Browser: offscreen node496 located via sidebar, edited and autosaved, then unmounted by panning and restored with text and dragged position intact.
- Browser drag: zero saves during an850ms pointer hold, one save after release;499 other nodes and all125 edges unchanged.
- Browser: changing source497 text updated target499 composer prompt through its existing edge.
