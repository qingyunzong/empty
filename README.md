# propcore

A tiny property-based testing core (Python 3.11+ standard library only) with
deterministic generation, automatic shrinking and a known-failure cache.

## Usage

```
python -m propcore test spec.json --runs 200 --seed 11 --db cache.json
```

- `--runs`: generated cases per property (default 100)
- `--seed`: random seed; the same seed always yields the same sequence
- `--db`: optional known-failure cache (JSON)

Output is a JSON report with `status`, `runs`, `failures`, `shrinks`.
Exit codes: `0` PASS / KNOWN_FAIL, `1` PROPERTY_FAIL / ERROR, `2` invalid spec.

## Spec format

```json
{
  "properties": [
    {"name": "lt5", "gen": {"type": "int", "min": 0, "max": 10}, "expr": "value < 5"}
  ]
}
```

Generators: `int` (`min`/`max`), `list` (`of`, `min_length`, `max_length`),
`dict` (fixed `fields`), `oneof` (`choices`). Properties are Python
expressions evaluated against `value` with a restricted builtin set.

## Semantics

- Generation and shrinking share one random source per property; shrinking
  itself is a deterministic greedy descent over candidates ordered by size
  ascending, ties broken by canonical JSON order.
- Cache keys are `property_name|generator_version`; any generator (or
  library version) change invalidates old entries. A cache hit is always
  re-confirmed by one real evaluation: confirmed failures are skipped and
  reported as `KNOWN_FAIL`, stale entries are dropped and re-run in full, so
  the cache never masks a new failure. Fresh failures (`ERROR` >
  `PROPERTY_FAIL`) outrank `KNOWN_FAIL` in the overall status.
- Exceptions during evaluation count as failures but are reported as `ERROR`,
  kept separate from `PROPERTY_FAIL`.

## Tests

```
python -m unittest discover -s tests -v
```
