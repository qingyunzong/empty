# Test Results

Recorded: 2026-10-07 04:47:13 UTC on node v22.22.1, tsc 7.0.2.

## `npm test` (build + node --test)

```
ok 1 - dist/test/cache.test.js
ok 2 - dist/test/cli.test.js
ok 3 - dist/test/mus.test.js
ok 4 - dist/test/parser.test.js
ok 5 - dist/test/solver.test.js
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 383.419661
```

## Individual tests (26 total, all passing)

```
# dist/test/cache.test.js
ok 1 - add normalizes order and rejects duplicates
ok 2 - a conflict is reusable only while every source still exists
ok 3 - findApplicable requires the conflict sources to be active
ok 4 - re-adding a retracted assumption makes the old conflict reusable again
# dist/test/cli.test.js
ok 1 - cli end-to-end
# dist/test/mus.test.js
ok 1 - combinations are generated in lexicographic tuple order
ok 2 - finds the minimum unsatisfiable subset with a full minimality proof
ok 3 - ties between minimum cores are broken by smallest id order
ok 4 - id order, not file order, decides ties
ok 5 - satisfiable input yields the lexicographically smallest assignment
ok 6 - proof tree shows the core, its witnesses, and the minimality count
ok 7 - paused search resumes to the identical result
ok 8 - constraint limit is explicit and enforced
# dist/test/parser.test.js
ok 1 - precedence: & binds tighter than |
ok 2 - precedence: | binds tighter than ->, -> is right associative
ok 3 - precedence: <-> is the weakest operator
ok 4 - negation binds tightest and stacks
ok 5 - parentheses override precedence
ok 6 - keyword and symbolic operators are equivalent
ok 7 - constants true/false/1/0
ok 8 - parse errors are reported
# dist/test/solver.test.js
ok 1 - lexicographically smallest assignment prefers 0 for earlier variables
ok 2 - unsatisfiable conjunction scans the whole table
ok 3 - row 0 is the all-false assignment, last row all-true
ok 4 - empty conjunction is satisfied by the all-false assignment
ok 5 - pause and resume reproduce the uninterrupted result
ok 6 - unsat scan pauses mid-table and finishes after resume
ok 7 - variable limit is explicit and enforced
```
