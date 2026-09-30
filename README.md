# clashd

Compiles a rule set into a deterministic decision engine. Pure Python 3.11+
standard library; no dependencies.

## Usage

```
python -m clashd decide rules.json req.json
```

Prints a JSON decision to stdout, e.g. `{"decision": "allow", "winning_rule": "r1"}`.
On `PolicyError` the CLI prints `{"error": {"code": ..., "message": ...}}` to
stderr and exits with code 2.

## rules.json

```json
{
  "default": "deny",
  "rules": [
    {
      "rule_id": "r1",
      "action": "allow",
      "priority": 10,
      "resource": "docs/*",
      "conditions": {"attr": "age", "op": "ge", "value": 18}
    }
  ]
}
```

- `resource` glob: `*` matches one segment, `**` matches zero or more.
- Specificity: more literal segments/characters and fewer wildcards is more
  specific.
- `conditions`: tri-state DSL with `and` / `or` / `not` / `exists` and
  comparisons `{"attr", "op", "value"}` where `op` is one of
  `eq ne lt le gt ge in`.

## req.json

```json
{"resource": "docs/a", "attributes": {"age": 20}}
```

## Decision semantics

1. Total order: priority desc, then specificity desc, then `rule_id`
   lexicographic. A full tie (identical triple) is a config error `E_TIE`.
2. `deny` overrides `allow` only inside the highest comparable layer; it never
   crosses into lower priorities.
3. The default decision must be configured explicitly; if no rule matches and
   no default exists, the engine raises `E_NO_DEFAULT` (never an implicit deny).
4. Conditions short-circuit (`and` stops at FALSE, `or` stops at TRUE). An
   unknown attribute yields UNKNOWN, and UNKNOWN is not FALSE: an UNKNOWN top
   layer blocks lower layers and yields decision `"unknown"`.
5. The result always carries `winning_rule` (rule id) or `none` (JSON null)
   when the default decided.

## Tests

```
python -m unittest discover -s tests -v
```

Includes a randomized cross-check (200 requests per seed) of
`clashd.policy.decide` against the independent scan-based reference
implementation in `clashd/reference.py`.
