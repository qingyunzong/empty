# merklesync

Bounded-round Merkle interval diff for ordered key-value JSONL streams.
Pure Python 3.11+ standard library; tests use `unittest`.

## Input format

Each input file is JSONL: one `{"key": ..., "value": ...}` object per line,
keys unique and sorted ascending (numbers before strings). Duplicate or
out-of-order keys are rejected with exit code 3.

## CLI

```
python -m merklesync diff A B --max-rounds R
```

Stdout is a JSON object:

- `equal`: true only when the canonicalized streams are identical.
- `diff`: list of `{"op": "add"|"remove"|"change", ...}` entries sorted by key.
- `rounds`: number of hash-exchange rounds used (round 1 is the root comparison).
- `incomplete`: true when `R` rounds elapsed before all differing intervals
  reached leaves; `diff` is then empty and `suspects` lists the unresolved
  intervals (index ranges plus key bounds) instead of fabricating keys.
- `suspects`: suspicious intervals when `incomplete` is true, else `[]`.

Exit codes: `0` success (including incomplete), `2` malformed input or bad
arguments, `3` duplicate or unsorted keys. Errors go to stderr.

## Protocol semantics

- Each line is canonicalized (`json.dumps` with sorted keys and compact
  separators), so whitespace/formatting-only differences compare equal.
- Interval hash = `sha256` of the concatenated canonical lines of the
  substream; an empty interval hashes to the fixed constant `sha256(b"")`.
- Round 1 compares root hashes; equal roots mean empty diff even if the raw
  file bytes differ. Each further round bisects every differing non-leaf
  interval at the median key of the merged key multiset; only leaves
  transfer key-values.

## Tests

```
python -m unittest discover -s tests -v
```

`TEST_LOG.txt` contains the recorded output of the last full run.
