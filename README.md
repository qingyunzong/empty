# shrink

Budget-aware minimizer for failing op sequences. Python 3.11+ standard library only.

## Usage

```
python -m shrink minimize case.json --budget 200 --out min.json
```

Exit codes: `0` on success (any status), `2` on invalid input.

## Case format

```json
{
  "ops": [{"name": "a", "args": {...}}, ...],
  "fail_when": {
    "type": "consecutive",
    "pattern": [
      {"name": "a"},
      {"name": "b", "args_key": "k", "equals": 1},
      {"name": "c", "args": {"mode": "x"}}
    ]
  },
  "arg_candidates": {"b": [{"k": 1}]}
}
```

- `ops` (required): list of `{"name": str, "args": object}` (`args` optional, defaults to `{}`).
- `fail_when` (required): built-in predicate rule. Type `"consecutive"` fails iff the
  pattern matches a consecutive window of the op sequence. Pattern elements support
  `name` (equality), `args` (subset match; missing key = no match), and `args_key`
  (direct lookup — a missing key raises, and predicate exceptions are treated as
  "not failing", so such candidates are never kept).
- `arg_candidates` (optional): per-name list of replacement args.

## Minimization semantics

- Only three transformations: contiguous block deletion, single-op deletion,
  and args replacement with a given candidate.
- Every predicate evaluation (including the initial check) costs 1 check against
  `--budget`. On exhaustion the CLI returns `BUDGET_EXCEEDED` with the current
  best and does not claim minimality.
- Candidate ordering key: `(length, [(name, canonical_json(args)), ...])` —
  shorter first, then op name, then args JSON; remaining ties resolve stably.
- After a fixpoint is reached, every single-op deletion is re-verified to be
  non-failing; only then is the result marked `1_MINIMAL`. If verification
  itself exhausts the budget, the status is `UNKNOWN_MINIMALITY`.

## Output

```json
{"status": "1_MINIMAL|UNKNOWN_MINIMALITY|BUDGET_EXCEEDED",
 "ops": [...], "checks": <predicate evaluations used>, "reason": "..."}
```

## Tests

```
python -m unittest discover -s tests -v
```
