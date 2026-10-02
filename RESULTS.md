# RESULTS

Recorded from real runs on 2026-10-03, Node.js v22.22.1 (`/usr/bin/node`),
offline, standard library only.

## Test suite: `node --test`

```
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 24881.228806
```

Per-file breakdown (each file run directly with `node <file>`):

| File | Tests | Pass | Fail |
| --- | --- | --- | --- |
| test/acceptance.test.js | 6 | 6 | 0 |
| test/brute.test.js | 6 | 6 | 0 |
| test/cli.test.js | 7 | 7 | 0 |
| test/policy.test.js | 4 | 4 | 0 |
| test/spec.test.js | 9 | 9 | 0 |
| **Total** | **32** | **32** | **0** |

## Acceptance criteria coverage

1. **Self-approval counterexample, amount 101** -
   `test/acceptance.test.js` "finds the minimal self-approval
   counterexample with amount 101": length-2 sequence
   `[alice submit 101, alice approve 101]`. PASS
2. **Deny yields proof with verified coverage** - "deny of self-approval
   yields a proof with full coverage": certificate `combinations = 40`
   (4 subjects x 2 actions x 5 amounts), `evaluations = 480`
   (40 x 2 self-contexts x 6 positions), 64-hex SHA-256 hash. PASS
3. **Revocation invalidates the old counterexample** -
   "revoking the allow rule removes the old counterexample" (proof) and
   "revocation is not retroactive" (revoke at position 2 keeps the
   length-2 witness). PASS
4. **Cross-check vs independent enumerator** - `test/brute.test.js`
   compares `findCounterexample` against `brute.js` item by item
   (length, sequence, violation) on 6 specs covering allows, deny-self,
   deny-amount, revocations and role inheritance. PASS

## CLI runs

```
$ node cli.js examples/self-approval.json /tmp/counterexample.json
counterexample: 2 actions written to /tmp/counterexample.json   (exit 0)

$ node cli.js examples/self-approval-deny.json /tmp/proof.json
proof: no counterexample within 6 actions
(certificate 57ff0a6652bdddb7d0ec0293b73fee5e310b614c02ed1b5782259112343a96cb)   (exit 0)

$ node cli.js examples/self-approval-revoke.json /tmp/proof2.json
proof: no counterexample within 6 actions
(certificate 1d63aedc06eb56662d8f41b73c5e8539f6dad1d236ef0cfe09c42a2d2299cab0)   (exit 0)

$ node cli.js /tmp/bad-spec.json /tmp/out.json   # malformed JSON
E_PARSE: invalid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)   (exit 1)
```

## Environment note

The sandboxed test environment cannot capture stdio of spawned child
processes, so CLI exit codes and output files are asserted via subprocess
spawns while the `E_PARSE` stderr message itself is asserted by driving
`cli.js#main` in-process (`test/cli.test.js`).
