# gmin

Budgeted test-case minimizer driven by an exit-code oracle.

## Usage

```
python -m gmin reduce input.txt --oracle oracle.py --budget 300 --out reduced.txt
```

- `oracle.py` defines `main()`, reads the candidate from stdin (UTF-8),
  and exits with code `42` when the target defect is triggered. Any other
  exit code, or a timeout (1s), counts as *not triggered*.
- The CLI prints a JSON report `{"status", "bytes", "checks"}` and writes
  the final candidate to `--out`.

## Semantics

1. Candidates are always valid UTF-8: all transformations operate on
   decoded `str`, so multi-byte characters are never split.
2. Transformation priority: delete contiguous line blocks, delete a single
   line, delete contiguous character blocks within a line, replace a
   character with an entry from the replacement table.
3. Every oracle invocation (including the final verification) consumes one
   unit of budget.
4. When the budget is exhausted the status is `BUDGET_EXCEEDED` and the
   current (not necessarily minimal) candidate is written out.
5. Termination requires verifying that no single-line deletion and no
   single-character deletion still triggers the defect; only then is the
   result reported as `MINIMAL`.

## Exit codes

- `0`: finished (`MINIMAL`, or `NOT_TRIGGERED` when the original input
  does not trigger the defect)
- `1`: `BUDGET_EXCEEDED`
- `2`: oracle missing/unreadable input

## Tests

```
python -m unittest discover -s tests -v
```
