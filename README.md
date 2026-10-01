# shrink

Budget-limited minimizer for failing test cases, Python 3.11+ standard library only.

## Usage

```
python -m shrink minimize case.json --budget 200 --out min.json
```

`--budget` defaults to 1000; without `--out` the result JSON is printed to stdout.
Invalid input (unreadable file, malformed JSON, invalid case, bad CLI args) exits with code 2.

## Case format

```json
{
  "ops": [{"name": "step1", "args": {"n": 10}, "candidates": [{"n": 7}]}],
  "fail_when": {"type": "contains_subsequence", "names": ["a", "b", "c"]}
}
```

- `ops`: list of `{name, args?}`; `args` defaults to `{}`. An op may declare
  `candidates`: a list of replacement `args` objects for the arg-replacement transform.
- `fail_when`: built-in predicate rule. The case "fails" when the predicate returns true.
  Built-in rules: `always`, `never`, `min_length` (`n`),
  `contains_subsequence` (`names`, contiguous), `args_sum_at_least` (`key`, `threshold`).

## Semantics

- **Transforms** (only these): deletion of a contiguous block, deletion of a single op,
  replacement of one op's args by one of its declared candidates.
- **Exceptions**: a predicate that raises is treated as *not failing*; the candidate
  that triggered the exception is never kept.
- **Budget**: every predicate evaluation (check) consumes 1 budget unit. When the budget
  is exhausted during minimization the result is `BUDGET_EXCEEDED` with the current best
  ops and `UNKNOWN_MINIMALITY` — minimality is never claimed without proof.
- **1-minimality**: after minimization, every single-op deletion is re-checked. Only if
  none of them fails is the result marked `1_MINIMAL`; if the verification itself runs
  out of budget the status stays `OK` but minimality is `UNKNOWN_MINIMALITY`.
- **Tie-breaking**: candidates are ordered by (length, op names lexicographically,
  canonical args JSON); the smallest failing candidate wins, so the result is
  deterministic. Arg replacements are only accepted when they strictly improve this
  order, which guarantees termination even for non-monotonic predicates.

## Output

```json
{"status": "OK|BUDGET_EXCEEDED", "ops": [...], "checks": 35,
 "reason": "...", "minimality": "1_MINIMAL|UNKNOWN_MINIMALITY"}
```

## Tests

```
python -m unittest discover -s tests -v
```
