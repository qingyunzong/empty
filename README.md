# sampling-rule-merge

Offline three-way merge library and CLI for inspection sampling rules.
Node.js 22, standard library only, tests via `node:test`.

## Rule model

```json
{ "id": "r1", "material": "steel", "grade": "A", "priority": 1, "enabled": true, "fraction": 0.5, "action": "accept" }
```

- The feature domain is the explicit `materials` x `grades` enumeration from the domain file.
- `fraction` must be in `[0, 1]`; `material`/`grade` must belong to the domain.

## Merge semantics

1. **Structural merge** by rule id, then field-by-field three-way merge
   (add/add, delete/modify and per-field divergent edits are conflicts).
2. **Semantic check** per feature: among enabled rules the highest `priority`
   wins, ties break by lexicographic `id`. If local and remote each change the
   winning action for a feature (relative to base) into different actions, it
   is a semantic conflict even when the winning rule ids differ.

## CLI

```
node index.js merge-rules --domain d.json --base b.json --local l.json --remote r.json --out result.json
```

Rule files may be a JSON array or an object with a `rules` array.
The output file contains `{ rules, conflicts, decisions }` where `decisions`
maps each `material/grade` feature to `{ ruleId, action }` (or `null`).

Exit codes: `0` merged cleanly, `1` conflicts, `2` invalid rules or domain.

## Tests

```
node --test
```
