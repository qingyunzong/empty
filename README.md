# evpack

Offline regulatory evidence-pack validator and certificate issuer.
Node.js 22, standard library only, tests with `node:test`.

An evidence pack consists of **evidence rows** (`asserted` / `retracted` /
`unknown`), **exclusion rules** with priorities, and **claims** (restricted
relational-algebra selection + aggregate + comparison) whose conclusions are
`pass` / `fail` / `undecided`.

## Semantics

- **Three-valued logic.** Predicates and comparisons over NULL fields yield
  *unknown* (SQL-style), never silently false.
- **Completions.** Asserted rows matching the claim selection (minus
  rule-excluded rows) form the certain base. `unknown` and `retracted` rows
  whose selection is not definitely false are *pending*: the engine evaluates
  every completion (subset) of the pending set. All completions pass →
  `pass`; all fail → `fail`; otherwise → `undecided`. Unknown evidence is
  therefore never treated as unsatisfiable, and retracting local evidence
  degrades a `pass` to `undecided`, never to `fail`.
- **Aggregates.** `count` / `sum` / `min` / `max` with NULL semantics: NULLs
  are ignored by `sum`/`min`/`max`/`count(field)`; `count(*)` counts rows;
  empty input yields NULL (0 for `count`), and comparing NULL is *unknown*.
- **Rule priority.** Among rules that excluded evidence, the ones with the
  highest priority are reported as `appliedRules`; ties are all listed.
- **Incremental validation.** A per-rule inverted index (`ruleId → evidence
  keys`) is maintained per key on insert and per rule on rule-add. Claim
  results are cached with their dependency key sets; `retract` is O(1) on the
  store and invalidates only claims depending on that key — no full rescan.

## Certificates

`cert` binds a conclusion to the exact input state: `inputHash` (SHA-256 of
the canonical evidence base + rule set), `rulesVersion`, `hitEvidenceKeys`,
explicit `undecided` items, `appliedRules`, and a self-hash (`certHash`).
`verifyCert` / `evpack check` recompute and compare; any tampering or state
drift raises `E_CERT_MISMATCH`.

## CLI

```
evpack load <dir>                 # import evidence.jsonl [+ rules.json]
evpack rule add <json|file>       # add exclusion rule (E_DUP_RULE on dup id)
evpack retract <evidenceKey>      # retract one row (E_EVIDENCE_GONE if gone)
evpack verify <claim|file>        # print conclusion (E_UNDECIDED exit if undecided)
evpack cert <claim|file> [out]    # issue certificate JSON
evpack check <certfile>           # verify certificate (E_CERT_MISMATCH)
```

State lives in `$EVPACK_HOME` (default `./.evpack`). Exit codes: `0` ok,
`2` E_DUP_RULE, `3` E_EVIDENCE_GONE, `4` E_UNDECIDED, `5` E_CERT_MISMATCH.

### Formats

```jsonc
// evidence.jsonl (one per line)
{"key": "e1", "status": "asserted", "fields": {"amount": 60, "region": "EU"}}

// rules.json / rule add
{"id": "no-estimates", "priority": 5, "when": {"op": "eq", "field": "kind", "value": "estimate"}}

// claim
{
  "select":    {"op": "and", "args": [{"op": "notnull", "field": "amount"},
                                      {"op": "gte", "field": "amount", "value": 0}]},
  "aggregate": {"op": "sum", "field": "amount"},
  "cmp":       {"op": "gte", "value": 100}
}
```

Predicate ops: `eq ne lt lte gt gte in isnull notnull and or not true false`.
Aggregate ops: `count sum min max` (`count` may omit `field` for `count(*)`).

## Library

```js
import { Store, Engine, issueCert, verifyCert } from './index.js';
```

## Tests

```
node --test        # see TEST_RESULTS.txt for the saved real run
```

Includes a differential test ("对拍") of the incremental engine against a
naive reference that enumerates all subsets of pending evidence, on
randomized 500-evidence packs.
