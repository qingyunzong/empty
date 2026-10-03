# tri-merge

Offline, zero-dependency three-way merge library and CLI for scientific
observation datasets. Requires Node.js >= 22, standard library only.

## Data format

Each input is a JSON object keyed by record id. Every record is an object of
fields (e.g. `value`, `unit`, `tags`, `annotations`):

```json
{
  "obs-001": {
    "value": 12.5,
    "unit": "m",
    "tags": ["calibrated"],
    "annotations": { "reviewer": "alice" }
  }
}
```

## CLI

```
node src/cli.js merge <base.json> <left.json> <right.json> --out <dir>
```

Exit codes:

| Code | Meaning      | Output                                  |
| ---- | ------------ | --------------------------------------- |
| 0    | clean merge  | `merged.json` + `certificate.json`      |
| 2    | conflicts    | `conflicts.json` only (no partial merge)|
| 1    | usage / I/O  | error message on stderr                 |

## Merge semantics

Field-level three-way merge per record id:

- Only one side changed a field -> that side wins.
- Both sides changed it identically -> clean merge.
- Both sides changed it differently -> conflict.
- Missing from base = added; missing from a side = deleted.

Conflict classification:

- `both-modified` — same field changed to different values on both sides.
- `both-added` — same record/field added on both sides with different values.
- `modified-vs-deleted` — one side changed it, the other deleted it.

Records deleted on both sides (or deleted on one side and untouched on the
other) are removed without conflict.

## Certificate

`certificate.json` is a deterministic SHA-256 state certificate: hashes of the
canonical (key-sorted) JSON of all three inputs and of the merged result, plus
record/conflict counts. Identical inputs always produce an identical
certificate.

## Library

```js
import { mergeDatasets } from './src/merge.js';
import { buildCertificate } from './src/certificate.js';

const { merged, conflicts, stats } = mergeDatasets(base, left, right);
```

## Tests

```
node --test
```
