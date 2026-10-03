# RESULTS

Command: `node --test` (Node v22.22.1), run at 2026-10-03T03:26:06Z.

## Summary

- Test files: 1 passed, 0 failed
- Individual tests: 5 passed, 0 failed

## Acceptance criteria

1. Capacity 3, place 3 -> success; one more -> `E_CAPACITY` (also verified
   exactly-equal boundary commits and same-transaction overflow): **PASS**
   (`single txn fills capacity exactly, overflow by 1 rejected`)
2. Two concurrent transactions read the same remaining capacity and commit
   different orders whose total exceeds capacity: first commits, second fails
   predicate revalidation with `E_SNAPSHOT`; non-overlapping slots commit
   concurrently: **PASS**
   (`concurrent txns: predicate revalidation prevents oversell`)
3. <=4 overlapping/adjacent slot operations (insert/adjust/cancel): predicate
   index enumeration matches a naive interval-scan reference for every
   sub-range: **PASS**
   (`index enumeration matches naive interval scan (<=4 ops per case)`)

## Supporting tests

- `commit certificate carries txn id, timestamp and predicate hashes`: **PASS**
- `CLI runCommands handles a full plan with E_CAPACITY result`: **PASS**

## Raw tally (node --test)

```
# tests 1
# pass 1
# fail 0
```

Subtests in `test/acceptance.test.js`: 5 ok, 0 not ok.
