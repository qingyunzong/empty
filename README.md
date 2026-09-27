# Add-Wins OR-Set

Pure Python 3.11 standard library implementation of an add-wins
observed-remove set (OR-Set) with compaction, plus a JSON-lines CLI.

## Semantics

- `add(e)` generates a globally unique tag `(node, counter)`.
- `remove(e)` tombstones only the tags currently visible at the replica;
  concurrent (undelivered) adds survive.
- `merge` is the union of live tags minus the union of known tombstones;
  it is commutative, associative and idempotent.
- `compact` folds live tags that every known node has observed into a
  summary tag. The summary records the covered tags so that:
  - late-arriving raw tags are recognised as already represented,
  - a remove that observed exactly the covered tags still removes the
    element (compaction is transparent),
  - replaying an old, already-delivered remove is a no-op and cannot
    kill revived elements.
- A remove never affects an add it has not observed.

## CLI

```
python orset.py STATE_FILE [--node NODE_ID] < commands.jsonl
```

Reads JSON commands from stdin, one per line, prints one JSON result per
line, and persists the replica state to `STATE_FILE`. Errors print
`{"ok": false, "error": ...}` and exit with code 4.

Commands:

- `{"op":"add","e":"x"}`        -> `{"ok":true,"tag":["A",1]}`
- `{"op":"rem","e":"x"}`        -> `{"ok":true,"removed":1}`
- `{"op":"merge","file":"b.json"}` (one-way merge of another state file)
- `{"op":"compact"}`            -> `{"ok":true,"summaries":2}`
- `{"op":"contains","e":"x"}`   -> `{"ok":true,"result":true}`
- `{"op":"dump"}`               -> `{"ok":true,"state":{...}}`

## Tests

```
python -m unittest discover -s tests -v
```
