# RESULTS

Recorded from real runs on 2026-10-03T02:25:53Z, Node.js v22.22.1, Linux
(offline, standard library only).

## Test suite (`node --test`)

```
✔ test/acceptance.test.js
✔ test/cli.test.js
✔ test/crosscheck.test.js
tests 3 files / 14 tests, pass 14, fail 0
```

Per-test results (each file also run directly):

```
test/acceptance.test.js
ok 1 - acceptance 1: self-approval counterexample with amount 101
ok 2 - acceptance 2: deny rule yields proof with full coverage certificate
ok 3 - acceptance 3: revocation only affects the future
ok 4 - acceptance 3b: with the old allow removed there is no counterexample

test/cli.test.js
ok 1 - cli writes counterexample.json for violable spec
ok 2 - cli writes proof.json for denied spec
ok 3 - cli exits 1 with E_PARSE on malformed JSON
ok 4 - cli exits 1 with E_PARSE on schema violations
ok 5 - cli exits 1 with E_PARSE when spec file is missing
ok 6 - cli exits 2 on wrong argument count

test/crosscheck.test.js
ok 1 - acceptance 4: independent enumerator agrees on self-approval.json
ok 2 - acceptance 4: independent enumerator agrees on self-approval-deny.json
ok 3 - acceptance 4: independent enumerator agrees on self-approval-revoke.json
ok 4 - acceptance 4: independent enumerator agrees on self-approval-revoked.json
```

## Acceptance criteria mapping

1. Self-approval counterexample, amount 101: `specs/self-approval.json`
   (4 subjects, bound 6) -> `counterexample`, length 2,
   `submit(alice,101) ; approve(alice,0)`, violation amount 101 > 100.
2. Deny added: `specs/self-approval-deny.json` -> `proof`, coverage
   2 subjects x 2 actions x 5 amounts = 20 combinations, certificate
   `sha256:88658046a5dae22ebc523c9a7c8cf9b9e9420f5d01d3d26902611d7f20bab6ea`,
   re-verified in tests via `verifyCertificate` and an independent hash.
3. Revocation: `specs/self-approval-revoke.json` still yields the length-2
   counterexample (revocation is future-only), while
   `[revoke(r2), submit(alice,101), approve(alice,0)]` and
   `[submit(alice,101), revoke(r2), approve(alice,0)]` are rejected at the
   approve step; `specs/self-approval-revoked.json` (old allow gone) ->
   `proof`, certificate
   `sha256:64f74071a054ceec6187fdbd97f09e4ba0a4ac873b11958b00277631e2f2d72d`.
4. Cross-check: `testlib/helpers.js` independently re-implements
   authorization, transitions, invariant and canonical form; for all four
   specs it agrees with the library on status, minimal length, the
   lexicographically smallest counterexample, and the full set of minimal
   counterexamples (item-by-item).

## CLI demo runs

```
$ node cli.js specs/self-approval.json out.json
counterexample (length 2): submit(alice,101) ; approve(alice,0)

$ node cli.js specs/self-approval-deny.json out.json
no counterexample up to length 6; coverage 20 combinations; certificate sha256:88658046a5dae22ebc523c9a7c8cf9b9e9420f5d01d3d26902611d7f20bab6ea

$ node cli.js specs/self-approval-revoke.json out.json
counterexample (length 2): submit(alice,101) ; approve(alice,0)

$ node cli.js specs/self-approval-revoked.json out.json
no counterexample up to length 6; coverage 20 combinations; certificate sha256:64f74071a054ceec6187fdbd97f09e4ba0a4ac873b11958b00277631e2f2d72d
```

Malformed input exits 1 with `E_PARSE`:

```
$ node cli.js bad.json out.json   # bad.json contains "{ not valid json"
E_PARSE: invalid JSON in bad.json: Expected property name or '}' in JSON at position 2 (line 1 column 3)
(exit code 1)
```
