# RESULT

Date: 2026-10-02 · Node v22.22.1 · stdlib only · `node --test`

## Test run (real output)

```
$ node --test
ok 1 - test/acceptance-a.test.js
ok 2 - test/acceptance-b.test.js
ok 3 - test/acceptance-c.test.js
ok 4 - test/acceptance-d.test.js
ok 5 - test/errors.test.js
ok 6 - test/helpers.js
# tests 6
# pass 6
# fail 0
# duration_ms 3444.9
```

## Acceptance coverage

- **A — cross-tenant, same device** (`test/acceptance-a.test.js`):
  t1 inherits group `g1` grant → bitmap `1111`; t2 has only an event-level
  exception for `e2` → bitmap `0100` with `missing_grant` counterexample on
  the rest; t3 has both deny `r3` and allow `r4` → deny wins on plain events,
  but `e3` (`downtime` on a `safety-public` device) breaks the deny → bitmap
  `0010`, and `audit.jsonl` records
  `brokenDeny.reason: "event is 'downtime' on a 'safety-public' device; allow rule 'r4' breaks deny rule 'r3' for action 'read'"`.
- **B — revocation** (`test/acceptance-b.test.js`): stats snapshot taken at
  T1 (`{read:2, modify:2, mark_false_positive:0}`) is byte-identical after the
  grant is revoked at T2 (append-only `stats.jsonl`); the same `query` at T1
  still yields bitmap `11` (as-of semantics) while at T3 it yields `00` with a
  `missing_grant` counterexample; audit shows `matchedRules:["r1"]` before and
  `matchedRules:[]` after.
- **C — false-positive marking** (`test/acceptance-c.test.js`): authorized
  `mark-fp` appends `{"seq":3,"type":"fp_mark","eventId":"e1","deviceId":"d1",...}`
  without modifying the original event line (file prefix check); queries then
  report `falsePositive:1` for `e1` only; unauthorized tenant exits 3, file
  unchanged, denial audited with counterexample.
- **D — enumeration cross-check** (`test/acceptance-d.test.js`): seeded
  random policy with 12 subjects (8 tenants + 4 chained groups) and 12 tags,
  40 mixed allow/deny/tag/event-exception rules (some revoked); all
  subject × event × action × as-of-time combinations (1728 decisions) of the
  main evaluator match the independent set-fixpoint reference evaluator, and
  every denial carries a minimal counterexample.

## Exit codes verified (`test/errors.test.js`, spawned processes)

- exit 8 — event seq 100 after max seq 500 (window 100): "beyond window 100"
- exit 4 — `g1 ↔ g2` inheritance cycle
- exit 9 — unknown tag on device (`nope`) and in rule (`ghost`)
- reordering within the window (seq 450 after 500) exits 0

## Sample CLI output (demo policy: g1→t1 allow, t2 event exception, t3 deny+allow)

```
query t1 read  → bitmap 1111
query t2 read  → bitmap 0100  (e1: counterexample missing_grant {subject:t2, tag:line-a, actions:[read]})
query t3 read  → bitmap 0010  (e3 allowed via brokenDeny r4≻r3; e4: counterexample extra_revocation ruleId r3)
mark-fp e1 t1  → {"marked":"e1","device":"d1","by":"t1"}
stats t1       → {"counts":{"read":4,"modify":4,"mark_false_positive":4}}
audit.jsonl    → {"cmd":"query","tenant":"t1","event":"e1","decision":"allow","matchedRules":["r1"]} ...
```
