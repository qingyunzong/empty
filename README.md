# wire-snap-editor

Integer-vertex drag editing library with threshold-based wire snapping,
self-intersection rejection, and single-step undo. TypeScript, no runtime
dependencies.

## Model

- Shapes are closed polygons with integer vertices (`addShape` validates
  vertex count, integer coordinates, and rejects self-intersecting rings).
- Every edge of a shape is a **wire** named `<shapeId>:e<i>`.

## Drag semantics (`Editor.dragVertex`)

1. The target point must have integer coordinates, otherwise the drag is
   rejected with a reason.
2. Candidate wires are the edges of all *other* shapes whose squared
   distance to the target is within `threshold^2`. (Snapping a vertex onto
   an edge of its own polygon always creates a self-touch, so those edges
   are never useful candidates.)
3. Candidates are ordered by squared distance, ties broken by ascending
   wire id, and verified one by one: the vertex is snapped to the nearest
   integer point on the wire, and the snap is rejected if it leaves the
   edited shape degenerate (zero-length edge) or self-intersecting.
4. The first legal candidate wins and is recorded as a single undoable
   step (`undo()` restores drags in LIFO order). If every candidate is
   rejected, the drag is not applied and the shape is left untouched.

Every `DragResult` carries `attempts` (per-candidate snap point, squared
distance, accept/reject reason) and `reasons` (human-readable rejection
log), so rejections are fully auditable.

## Scripts

- `npm run build` — compile to `dist/` with `tsc`
- `npm test` — compile, then run the `node:test` suites in `test/`
