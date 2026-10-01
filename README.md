# gmin

Line/character based test-case minimizer (Python 3.11+, standard library only).

## Usage

```
python -m gmin reduce input.txt --oracle oracle.py --budget 300 --out reduced.txt
```

The oracle script reads the candidate from stdin and exits with code `42`
when the target defect is present; any other exit code (or a timeout,
default 1s) counts as "not triggered". The CLI prints
`status=<OK|BUDGET_EXCEEDED> bytes=<n> checks=<n>` and writes the reduced
candidate to `--out`. A missing oracle exits with code 2.

## Reduction semantics

- All transformations operate on decoded text, so output is always valid UTF-8.
- Transformation priority: contiguous line-block deletion, single-line
  deletion, in-line contiguous character-block deletion, then character
  replacement from a fixed table (only strictly "simpler" table entries,
  guaranteeing progress).
- Every oracle call counts against the budget, including the final
  verification pass, which proves that no single-line deletion and no
  single-character deletion triggers the oracle anymore.
- When the budget is exhausted the current candidate is written with
  status `BUDGET_EXCEEDED` (not marked minimal).

## Tests

```
python -m unittest discover -s tests -v
```
