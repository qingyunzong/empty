# RESULTS

Date: 2026-10-03. Environment: Node.js v22.22.1, standard library only,
offline. All results below are real outputs from this workspace.

## Test run: `node --test`

```
ok 1 - test/cli.test.js
ok 2 - test/conflict.test.js
ok 3 - test/cycle.test.js
ok 4 - test/inheritance.test.js
ok 5 - test/random-graph.test.js
# tests 5
# pass 5
# fail 0
```

25 subtests in total, all passing:

| File | Subtests | Covers |
| --- | --- | --- |
| `test/inheritance.test.js` | 6 | acceptance 1: inheritance chain + revoke before/at/after |
| `test/conflict.test.js` | 6 | acceptance 2: deny>allow, nearer>farther, rule-id tie-break |
| `test/random-graph.test.js` | 2 | acceptance 3: 70 seeded random DAGs vs independent all-paths enumeration |
| `test/cycle.test.js` | 6 | acceptance 4: `E_CYCLE` on self-loop and multi-role cycles |
| `test/cli.test.js` | 5 | end-to-end outputs, hash-chain re-verification, error exit codes |

## CLI run: `node cli.js examples/policy.jsonl examples/events.jsonl examples/out/`

```
wrote 3 decisions to examples/out/decisions.jsonl, audit root a71807a24098ff97a5d695c906ce4123d3efe3afa2649dd6d52dae865eaee179
```

`examples/out/decisions.jsonl`:

```json
{"id":"e1","decision":"allow","rule":"r-read","path":["auditor","analyst","viewer"],"reason":"EXPLICIT_ALLOW","candidates":1,"hash":"3028f3dd5c3577fe283f1c61ceacfb1a872ce409edc86c2c4f8844196512d88a"}
{"id":"e2","decision":"deny","rule":null,"path":[],"reason":"DEFAULT_DENY","candidates":0,"hash":"e1c449a45a9a5aaaabe1ebd37f946e9778584aef7764b3397c1c4893d98058b7"}
{"id":"e3","decision":"deny","rule":"r-export-deny","path":["auditor","analyst","viewer"],"reason":"DENY_OVERRIDES_ALLOW","candidates":2,"hash":"a71807a24098ff97a5d695c906ce4123d3efe3afa2649dd6d52dae865eaee179"}
```

- `e1` (ts=50, before `viewer` revocation at 100): allowed through the
  3-role inheritance chain.
- `e2` (ts=150, after revocation): the same request now defaults to deny;
  the historical `e1` decision is untouched.
- `e3`: the explicit `deny` on `viewer` overrides the nearer `allow` on
  `analyst`.

`examples/out/audit.json`:

```json
{
  "version": 1,
  "algorithm": "sha256-chain",
  "genesis": "0000000000000000000000000000000000000000000000000000000000000000",
  "decisions": 3,
  "allows": 1,
  "denies": 2,
  "root": "a71807a24098ff97a5d695c906ce4123d3efe3afa2649dd6d52dae865eaee179",
  "policyHash": "84af70d393bd92f1fe4d3dec4697845ec0178df0fe46ce8aa2ce0d70eb58766e",
  "eventsHash": "644416be8515eb6c2e05e6d56f2d5dbfb9c13061a261f8dcf917a8f943e14711"
}
```

## Error path: cyclic inheritance

```
$ node cli.js /tmp/cyc.jsonl examples/events.jsonl /tmp/out/
{"error":{"code":"E_CYCLE","line":2}}
exit=1
```
