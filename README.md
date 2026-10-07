# vertex-snap-editor

A small TypeScript editor library for dragging integer polygon vertices onto
candidate wires, with validation and undo.

## Behavior

- **Candidates** — for a drag target, every wire whose closest point lies
  within the distance threshold becomes a candidate (one per wire, the best
  segment wins). Candidates are ranked by smallest squared distance first,
  then by ascending wire ID. The candidate set is finite and each one is
  verified in ranked order.
- **Snapping** — the vertex snaps to the closest point on the candidate wire,
  rounded to integer coordinates.
- **Self-intersection fallback** — if a snapped position would make the
  polygon self-intersect, that candidate is rejected (with a recorded reason)
  and the next legal candidate is tried.
- **Rejection reasons** — every refused candidate is reported with a
  machine-readable code (`SELF_INTERSECTION`) and a human-readable message;
  a fully failed drag explains why.
- **Undo** — a drag applies at most one accepted move, so the whole drag is a
  single undoable unit. `undo()` reverts drags in LIFO order; failed drags
  never touch the undo stack.

## API

```ts
import { Editor } from "./src/editor";

const editor = new Editor(vertices, wires, threshold);
const result = editor.dragVertex(vertexIndex, { x, y });
if (result.ok) {
  // result.accepted, result.to, result.rejected
} else {
  // result.reason, result.rejected
}
editor.undo();
```

## Test

```sh
npm test   # compiles with tsc and runs node --test on dist/test/*.test.js
```
