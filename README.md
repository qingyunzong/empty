# Clinical Sample Audit Scheduler

Node.js 22, standard library only (`node:test`, `node:crypto`, `node:util`).
Assigns reviewer time slots to clinical audit cases under skill x time-slot
constraints, risk/deadline ordering, department quotas, preemption with
compensation credits, and an append-only, hash-chained audit certificate.

## Layout

- `src/core.js` — state, event log, certificate, case lifecycle
  (open / correct / appeal / close / snapshot)
- `src/scheduler.js` — slot planner (priority order, dept quota, augmenting
  placement)
- `cli.js` — `open | assign | correct | appeal | close | snapshot`
- `test/*.test.js` — acceptance tests

## Model

- **Events** are ordered by `(logical time, source, case ID)`; the certificate
  is a SHA-256 hash chain over that canonical order, so it is independent of
  arrival order and recomputable after a crash.
- **Priority**: effective risk = `risk + agingRate*waitAge + creditWeight*credits`,
  then earliest statutory deadline, then case ID.
- **Fairness**: one department may take at most `deptQuota` (default 0.5) of a
  run's assignments while other departments are waiting; blocked cases keep
  waiting and age.
- **Preemption**: a higher-risk case may take a lower-risk case's
  not-yet-started slot; the displaced case gets `preemptCredit` compensation
  credits that boost its future priority. Started assignments are locked.
- **Appeals**: opening an appeal freezes the signed conclusion (never deletes
  it). Closing with `uphold` confirms it at the appeal's hierarchy level;
  `overturn` rolls it back (conclusion revoked to history, case reopens).
- **Exit 8**: `SKILL_MISMATCH`, `DEADLINE_PAST`, `DUPLICATE_APPEAL`.

## CLI

```
node cli.js open --state s.json --reviewer R1 --skills mol,ihc
node cli.js open --state s.json --case C1 --dept patho --risk 85 --deadline 6 --skill mol --now 0
node cli.js assign   --state s.json --now 0
node cli.js correct  --state s.json --case C2 --risk 95 --now 0
node cli.js appeal   --state s.json --case C1 --level 2 --now 2
node cli.js close    --state s.json --case C1 --now 1                  # sign conclusion
node cli.js close    --state s.json --case C1 --decision uphold --now 3 # resolve appeal
node cli.js snapshot --state s.json --out snap.json
node cli.js snapshot --state s.json --verify
```

## Real output (this repo, Node v22.22.1)

Risk correction re-orders unstarted assignments (`correct C2 40 -> 95`, then
`assign` swaps reviewers):

```json
{
  "ok": true,
  "command": "assign",
  "assignments": [
    { "caseId": "C2", "reviewer": "R1", "start": 0, "end": 1 },
    { "caseId": "C1", "reviewer": "R2", "start": 0, "end": 1 }
  ],
  "rejections": {},
  "preemptions": [],
  "certificate": "6b3361a0dea5586c3f701bbe5b96115d02bdd53ce1903af88bd30f128e143991"
}
```

High-risk preempts a low-risk not-yet-started task and grants credit:

```json
{
  "ok": true,
  "command": "assign",
  "assignments": [
    { "caseId": "HIGH", "reviewer": "R1", "start": 0, "end": 1 }
  ],
  "rejections": { "LOW": "NO_CAPACITY" },
  "preemptions": [
    { "caseId": "LOW", "credit": 15, "reason": "displaced_by_higher_risk" }
  ],
  "certificate": "03e607d0833690be66f805abf58bcad1f0c03c7fa922378d86bb7c234db95da5"
}
```

Duplicate appeal is rejected with exit code 8:

```
$ node cli.js appeal --state s.json --case C1 --now 3
{ "ok": false, "error": "DUPLICATE_APPEAL", "message": "case C1 already has an open appeal" }
$ echo $?
8
```

Snapshot after crash recovery recomputes the identical certificate:

```json
{
  "ok": true,
  "command": "snapshot",
  "certificate": "cc71df5a8ee90d2e48c2e579ef66a6a8509d73fb745e7e45eb3b1c13d5128892",
  "recomputed": "cc71df5a8ee90d2e48c2e579ef66a6a8509d73fb745e7e45eb3b1c13d5128892",
  "verified": true
}
```

## Tests

```
$ node --test test/*.test.js
# tests 5
# pass 5
# fail 0
```

- `test/scheduler.test.js` — n<=9 brute-force optimum vs scheduler on-time
  high-risk coverage (40 random instances)
- `test/fairness.test.js` — department quota caps monopoly; waiting cases age
- `test/lifecycle.test.js` — risk correction reorders, signed conclusions
  immutable, appeal freeze/confirm/rollback, concurrent event ordering
- `test/cli.test.js` — exit 8 on SKILL_MISMATCH / DEADLINE_PAST /
  DUPLICATE_APPEAL; assignment + rejection-code output
- `test/snapshot.test.js` — crash recovery recomputes certificate; tampering
  fails verification
