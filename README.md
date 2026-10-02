# obs3merge

Three-way merge library and CLI for scientific observation datasets. Pure
Node.js (>=22) standard library, no dependencies.

Datasets are JSON objects keyed by observation id; each record holds fields
such as `value`, `unit`, `tags`, `annotations`.

## CLI

```
node src/cli.js merge <base.json> <left.json> <right.json> --out <dir>
```

- Clean merge: writes `merged.json` and `certificate.json` (SHA-256 state
  certificate over the canonical merged result plus input digests), exit 0.
- Conflicts: writes `conflicts.json` only (no partial merge output), exit 2.
- Usage/IO errors: exit 1.

## Merge semantics

Field-level three-way merge per record:

- Only one side changed a field -> take that side.
- Both sides changed identically -> take it.
- Both sides changed differently -> conflict (`both-modified`).
- Record missing from baseline and added on both sides with different
  content -> conflict (`both-added`).
- One side modified, other side deleted -> conflict (`modify-delete`).
- Both sides deleted, or delete vs unmodified -> clean delete.

## Library

```js
import { mergeDatasets } from './src/merge.js';
const { merged, conflicts } = mergeDatasets(base, left, right);
```

## Tests

```
node --test
```
