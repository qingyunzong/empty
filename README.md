# propcore

A tiny deterministic property-based testing core (Python 3.11 standard
library only) with a JSON spec format, automatic shrinking and a
persistent known-failure cache.

## Usage

```
python -m propcore test spec.json --runs 200 --seed 11 --db cache.json
```

- `--runs` — generated values per property (default 100)
- `--seed` — seed of the shared random source (default 0)
- `--db`   — known-failure cache file (optional; no persistence without it)

Exit codes: `0` PASS / KNOWN_FAIL, `1` FAIL (a new failure was found),
`2` invalid spec or invalid arguments.

The report is JSON on stdout with exactly four keys:

```json
{"status": "PASS|FAIL|KNOWN_FAIL", "runs": 400, "failures": [...], "shrinks": 318}
```

Each failure record carries `property`, `kind` (`PROPERTY_FAIL` or
`ERROR`), the shrunk `value`, the `original` generated value, the `run`
index, a `known` flag and its own `shrinks` count.

## Spec format

```json
{"properties": [
  {"name": "small",
   "gen": {"type": "int", "min": 0, "max": 200},
   "expr": "value < 150"}
]}
```

Generators (nestable):

- `{"type": "int", "min": 0, "max": 10}`
- `{"type": "list", "of": <gen>, "min_len": 0, "max_len": 4}`
- `{"type": "dict", "fields": {"a": <gen>, ...}}`
- `{"type": "oneof", "options": [<gen>, ...]}`

`expr` is a Python expression evaluated over the generated `value` with a
whitelist of safe builtins (`abs`, `len`, `sum`, `sorted`, ...). A falsy
result is a `PROPERTY_FAIL`; a raised exception is an `ERROR`. Both count
as failures and both are shrunk, but they are reported separately.

## Semantics

1. **Determinism.** One `random.Random(seed)` drives all generation.
   Shrinking is a deterministic candidate enumeration that shares (but
   never consumes) that random source, so a fixed seed always reproduces
   the same run sequence, regardless of shrinking or cache state.
2. **Shrinking.** Only the current failing value is shrunk. Candidates
   are tried in canonical order — size ascending, ties broken by JSON
   serialisation order — and the first candidate reproducing the same
   failure kind is adopted. Small int domains are enumerated exhaustively,
   so the result agrees with brute-force reference enumeration, and ties
   (e.g. `-2` vs `2`) resolve stably to the JSON-smaller value.
3. **Cache.** Keys hash the property name, generator spec, expression,
   generator version (`propcore.generators.GEN_VERSION`) and the failing
   value. A hit is re-run once to confirm: only a confirmed failure is
   skipped and reported as `KNOWN_FAIL`; a stale entry that now passes is
   discarded. Bumping `GEN_VERSION` invalidates all old entries.
4. **Priority.** Any newly discovered failure makes the status `FAIL`,
   even when known failures were also observed.
5. **Errors.** Exceptions while running a property are failures of kind
   `ERROR`, kept separate from `PROPERTY_FAIL`.

## Tests

```
python -m unittest discover -s tests -v
```
