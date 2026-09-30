# clashd

Compiles a rule set into a deterministic decision maker. Pure Python
standard library (3.11+), no dependencies.

## Usage

```
python -m clashd decide rules.json req.json
```

Prints the decision as JSON on stdout, exit code 0. On any
`PolicyError` (invalid policy, `E_TIE`, `E_NO_DEFAULT`, ...) it prints
`{"error": {"code", "message"}}` on stderr and exits with code 2.

## Rule set format

```json
{
  "default": "deny",
  "rules": [
    {
      "rule_id": "eng-read",
      "action": "allow",
      "priority": 10,
      "resource": "db/users/*",
      "conditions": {"all": [{"eq": ["dept", "eng"]},
                             {"exists": "token"}]}
    }
  ]
}
```

* `default` is mandatory (`allow` or `deny`); a missing default is
  reported as `E_NO_DEFAULT`, never as an implicit deny.
* `resource` is a `/`-separated glob pattern; `*`/`?`/`[...]` work
  inside a segment and `**` matches zero or more whole segments.
* `conditions` is optional; operators: `all`, `any`, `not`, `exists`,
  `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `in`.

## Request format

```json
{"resource": "db/users/42", "attrs": {"dept": "eng", "token": true}}
```

## Decision semantics

1. Rules are totally ordered by priority (desc), resource specificity
   (desc: more exact segments, more literal chars, fewer wildcards),
   then `rule_id` (lexicographic). A full tie on all three is a
   configuration error (`E_TIE`).
2. A comparable layer is a group of rules tied on (priority,
   specificity). The highest layer with any matching or UNKNOWN rule
   decides; deny overrides allow only inside that layer and never
   crosses into a lower layer.
3. Conditions are three-valued and short-circuiting: an unknown
   attribute yields UNKNOWN, and UNKNOWN is not false. If the deciding
   layer has no definite match but an UNKNOWN condition, the decision
   is `"unknown"`.
4. The result contains `decision` (`allow`/`deny`/`unknown`),
   `winning_rule` (rule id or null) and `reason`
   (`rule`/`default`/`unknown_condition`).

## Tests

```
python -m unittest discover -s tests -v
```
