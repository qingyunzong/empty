# Test Results

- Date (UTC): 2026-10-05T07:12Z
- Runtime: Node.js v22.22.1, standard library only, `node:test`
- Command: `node --test`

## `node --test` summary (real output)

```
✔ test/acceptance.test.js (676.084184ms)
✔ test/errors.test.js (708.8235ms)
✔ test/merge-laws.test.js (5795.408857ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5944.902804
```

## Per-file subtests (real output, `--test-reporter=spec`)

```
== test/acceptance.test.js ==
✔ shuffled and duplicated ingest yields identical query output (9.24061ms)
✔ out-of-range correction goes to invalid, never silently dropped (1.41207ms)
✔ tombstone blocks resurrection of a deleted site (3.545192ms)
✔ compact keeps visible queries equivalent and requires min-vector coverage (7.522237ms)
ℹ tests 4 / pass 4 / fail 0

== test/errors.test.js ==
✔ BAD_RANGE: non-finite delta (8.312565ms)
✔ BAD_RANGE: invalid timestamp and inverted query range (1.778549ms)
✔ UNKNOWN_SITE: correction or delete for unregistered site (1.558251ms)
✔ TOMBSTONE_HIT: ingest correction for deleted site (1.50464ms)
✔ negative corrections are valid and visible by default (1.180406ms)
ℹ tests 5 / pass 5 / fail 0

== test/merge-laws.test.js ==
✔ merge is commutative for all permutations of <= 8 sites (1998.780998ms)
✔ merge is commutative over permutations including tombstones (30.619713ms)
✔ merge is associative (125.503535ms)
✔ merge is idempotent (162.944422ms)
ℹ tests 4 / pass 4 / fail 0
```

Total: 13/13 subtests passing.

## Acceptance criteria coverage

1. Out-of-order + duplicated ingest → identical query: `acceptance.test.js` test 1
   (also canonical store bytes identical; merge of both stores converges).
2. Out-of-range correction → `invalid`, evidence retained, default query filters it:
   `acceptance.test.js` test 2.
3. Tombstone blocks resurrection (ingest rejected with `TOMBSTONE_HIT` exit 4;
   merging a stale backup does not revive the site): `acceptance.test.js` test 3.
4. Compact only under min-frontier-vector coverage; visible queries equivalent
   before/after: `acceptance.test.js` test 4.

Merge laws (commutative over all ≤8-site permutations — 46,233 merges,
associative, idempotent): `merge-laws.test.js`.
