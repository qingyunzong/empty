# mvcc-scheduler

Offline single-machine scheduling library and CLI. Node.js 22, standard
library only, tests via `node:test`.

A work order is scheduled by picking one **plan** from its alternatives.
A plan is a list of `(machine, day, material, amount)` allocations that
consume per-`(material, day)` budgets (steel coils, work hours, and other
substitutable materials).

## Library

- `src/canon.js` — canonical JSON (sorted keys), canonical plan form
  (allocations normalized and sorted), lexicographic plan comparison and
  SHA-256 plan hashes.
- `src/store.js` — MVCC store. Every commit bumps a version; budgets and
  allocation entries are versioned. A secondary index maps
  `(material, day)` to versioned allocation entries, so budget predicates
  are evaluated without scanning unrelated allocations. Transactions read
  from a snapshot (snapshot isolation) and stage plans; `commit()`
  revalidates, at the **latest** committed version, the sum of all
  committed allocations plus staged amounts for every touched
  `(material, day)`, and rejects with `E_BUDGET` on overflow. Two
  transactions writing different work orders therefore cannot bypass a
  shared budget predicate (no write skew).
- `src/scheduler.js` — deterministic plan selection: among all plans
  feasible under the transaction snapshot, the smallest by canonical-JSON
  lexicographic order wins. The certificate records the snapshot version,
  the chosen plan hash, and the hashes of every feasible plan compared.
  Also: batch scheduling, joint-feasibility enumeration
  (`enumerateJointPlans`) and optimal joint scheduling (`scheduleJoint`).

## CLI

```
node cli.js [--file script.json] < script.json
```

Input:

```json
{
  "budgets": [{"material": "steel", "day": 1, "amount": 100}],
  "orders": [{"id": "o1", "plans": [[{"machine": "m1", "day": 1, "material": "steel", "amount": 80}]]}],
  "mode": "batch"   // "batch" (default) | "joint" | "enumerate"
}
```

Output is a single JSON object on stdout.

Exit conventions:

- `0` — success, `{"ok": true, ...}`
- `1` — scheduling error, `{"ok": false, "error": {"code": "E_BUDGET" | "E_NO_PLAN" | "E_INVALID" | "E_TXN_CLOSED", ...}}`
- `2` — usage/parse error, `{"ok": false, "error": {"code": "E_USAGE" | "E_PARSE", ...}}`

## Tests

`node --test` covers: canonicalization determinism; deterministic
selection with certificate hashes; concurrent transactions (60+60 fails
with `E_BUDGET`, 50+50 commits); exact budget exhaustion (100 commits,
then 0 commits, then 1 fails); snapshot isolation; per-`(material, day)`
secondary-index accounting; a seeded sweep (≤3 orders) cross-checking
`enumerateJointPlans`/`scheduleJoint` against an independent DFS
reference; and CLI exit-code/JSON conventions.

Recorded result of `node --test` (Node v22.22.1, see `test-results.txt`):

```
# tests 4
# pass 4
# fail 0
# duration_ms 12097.062941
```
