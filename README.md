# grid-pathlib

Shortest-action-path search on small grids (≤ 10×10) with keys (≤ 5),
one-shot doors, and undoable door opens. Written in dependency-free
TypeScript; tested with the Node built-in test runner.

## Model

- ASCII grids: `#` wall, `.` floor, `S` start, `G` goal, `a`–`e` keys,
  `A`–`E` doors (door `X` needs key `x`).
- Walking onto a key collects it. Opening an adjacent door consumes the
  matching held key; the door stays open (one-shot).
- `undo-open` on an adjacent open door restores the door and refunds the
  consumed key, so the key can be spent elsewhere.
- A full state is `(position, collected keys, open doors)`; held keys are
  derived as `collected & ~spent`.

## API

```ts
import { parseGrid, initialState, shortestPath, replayPath, StateStore } from './src/index.js';

const grid = parseGrid(`
#########
#Sa.A.AG#
#########
`);
const result = shortestPath(grid, initialState(grid));
// result.actions  — shortest action sequence (move / open / undo-open)
// result.verified — true after an independent replay of the path
const final = replayPath(grid, initialState(grid), result!.actions);

// Versioned, forkable state history:
const store = new StateStore();
const v0 = store.create(initialState(grid));
const v1 = store.commit(v0, applyAction(grid, store.state(v0), { kind: 'move', dir: 'right' }));
const branch = store.fork(v1, 'experiment'); // diverge without touching v1
```

## Test

```sh
npm test   # tsc + node --test
```
