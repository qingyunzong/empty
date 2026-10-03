# batch-genealogy-trace

Node.js 22, standard library only. Tracks factory batch genealogy: input batches are
transformed into output batches (one output may have many inputs). Batches can be
held, released, or shipped. The genealogy graph supports incremental append,
correct, and undo of transformation events while maintaining every batch's
blocked status and downstream-reachable diffs.

## Rules

- If any ancestor of a batch is held, unshipped descendants are automatically
  held; the block reasons list every held ancestor.
- A shipped batch keeps status `shipped`, but its certificate lists the risk
  paths from each held quality source to the batch.
- Unknown batches, duplicate output definitions, and cycles are errors.

## CLI

```
node src/cli.js trace events.json -o result.json
```

`events.json` is an array of operations (see `examples/events.json`):

```json
{"op":"define","batch":"A","kind":"input"}
{"op":"transform","output":"P","inputs":["A","B"]}
{"op":"hold","batch":"A"}            / {"op":"release",...} / {"op":"ship",...}
{"op":"correct","index":2,"event":{"op":"transform","output":"P","inputs":["B"]}}
{"op":"undo"}
{"op":"query","batch":"P"}
```

`result.json` contains per-mutation version diffs (status changes, added/removed
edges), query certificates (status, block reasons, deterministic full paths from
each quality source to the target), and error records. Exit code is `0` on
success, `1` when an operation failed, `2` for usage/input errors.

## Library

```js
const { Genealogy } = require('./src/genealogy');
const g = new Genealogy();
g.define('A', 'input');
g.define('P', 'output');
g.transform('P', ['A']);   // returns the version diff
g.hold('A');
g.query('P');              // certificate: status held, paths [['A','P']]
g.undo();                  // exact restore of the previous journal state
```

## Tests

```
node --test
```

Tests cover multi-level assembly blocking/release, shipped-batch risk
certificates, correct/undo exactness, cycle/unknown-parent/duplicate failures,
CLI end-to-end runs, and cross-check random small graphs against an independent
DFS reference (`testutil/reference.js`) that enumerates all paths by brute force.
