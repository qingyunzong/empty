# sampling-rule-merge

Offline three-way merge library and CLI for inspection sampling rules.
Node.js 22, standard library only, tests via `node:test`.

## Rule model

```json
{ "id": "r1", "material": "steel", "grade": "A", "priority": 1, "enabled": true, "fraction": 0.5, "action": "sample" }
```

The feature domain is the explicit enum given by the input domain file
(`{ "materials": [...], "grades": [...] }`); features are the
material x grade combinations. `fraction` must be in `[0, 1]` and every
rule's `material`/`grade` must belong to the domain.

## Merge semantics

1. **Structural merge** keyed by rule `id`, field-level within a rule:
   a field changed on only one side wins; both sides changing the same
   field to different values is a `field` conflict. Deleting a rule that
   the other side modified is a `delete-vs-modify` conflict; adding the
   same id with different content is an `add-vs-add` conflict.
2. **Semantic check** per feature: among enabled rules the highest
   `priority` wins, ties broken by lexicographic `id`. If local and
   remote both change a feature's effective action relative to base and
   the actions differ, it is a `semantic` conflict - even when the
   winning rules have different ids.

## CLI

```
node index.js merge-rules --domain d.json --base b.json --local l.json --remote r.json --out result.json
```

Exit codes: `0` merged cleanly, `1` conflicts, `2` invalid rules or domain.
The output JSON contains `status`, merged `rules`, `conflicts`, and the
effective per-feature `decisions` computed from the merged rules.

## Tests

```
node --test
```

Includes a property test that, for <= 8 features, enumerates every
enabled/disabled subset of the rules and cross-checks the library's
per-feature decision against an independent highest-priority scan.
