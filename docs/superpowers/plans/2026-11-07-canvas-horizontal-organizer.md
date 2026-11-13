# Canvas Horizontal Organizer Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in the current checkout, then run the listed verification.

**Goal:** Make “整理画布” lay each related input → generation → result chain horizontally so associated nodes read as one compact expandable unit.

**Architecture:** Extract the pure positioning algorithm from `ProjectCanvas.tsx` into a small canvas layout module so its relationship rules can be tested without React. Keep graph persistence behavior in `ProjectCanvas.tsx`; replace only coordinate calculation. Each edge-connected flow is a deterministic left-to-right layered relationship block: simple chains stay on one row, while branches fan out into vertically separated sub-rows. Independent flows in a logical shot/group stack below it, and project script cards occupy a separate left column.

**Tech Stack:** TypeScript, React Flow node geometry, Node test runner with tsx.

## Global Constraints

- Preserve existing node sizes, persisted positions, history, delayed save, and fitView behavior.
- Process every graph node, regardless of the toolbar visibility filter.
- Keep deterministic ordering based on graph node order and shot position.
- Do not add a layout dependency.

## Review Focus

- One generation with multiple inputs and multiple results stays left-to-right without overlap; branch cards occupy separate sub-rows when needed.
- Multi-stage generation pipelines keep every edge pointing left to right.
- Independent flows in one logical group stay together; shared and isolated nodes remain visible.
- Existing `project_script_ref` nodes stay in a separate column.
- Re-running organization is idempotent.

### Task 1: Extract and test horizontal relationship layout

**Files:**
- Create: `web/src/features/canvas/canvas-organize-layout.ts`
- Create: `web/test/canvas-organize-layout.test.ts`
- Modify: `web/src/features/canvas/ProjectCanvas.tsx:3306-3359`

**Interfaces:**
- Produces `organizeCanvasNodes(nodes, edges, getSize, getGroupOrder) -> Map<string, {x:number;y:number}>`.

- [x] Define the pure layout input/output types and implement deterministic group ordering.
- [x] Lay out each edge-connected flow as a topologically ordered horizontal row using node dimensions and fixed gaps.
- [x] Place independent flows in the same logical group together and reserve a separate column for script cards.
- [x] Add tests for chains, branching, multiple stages, shared/isolated nodes, metadata conflicts, and deterministic coordinates.
- [x] Replace the inline coordinate block with the helper while preserving `changeGraph`, notices, save, and fitView; include automatic visual reference edges in the layout input.
- [x] Run focused tests and the web type/build checks.
