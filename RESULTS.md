# RESULTS

Chain-of-evidence audit library + CLI. All output below is real, captured from the
commands shown. Environment: Node.js v22.22.1, standard library only, node:test.

## 1. Acceptance suite: `node --test`

```
TAP version 13
# Subtest: test/compact.test.js
ok 1 - test/compact.test.js
  ---
  duration_ms: 670.358252
  type: 'test'
  ...
# Subtest: test/enumeration.test.js
ok 2 - test/enumeration.test.js
  ---
  duration_ms: 914.767085
  type: 'test'
  ...
# Subtest: test/verify.test.js
ok 3 - test/verify.test.js
  ---
  duration_ms: 756.048973
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 986.230832
```

## 2. Enumeration cross-check counts (acceptance 4)

```
  cross-checked 7200 closures
  cross-checked 888 assay verdicts
```

## 3. CLI end-to-end demo (acceptances 1-3 via the CLI)

$ # build a chain: sample -> aliquot -> assay, then attest
$ node bin/cli.js verify demo.log --now 2026-01-01T06:00:00Z
VALID	X1	chain complete; attested sig:auditor-1
  certificate: {"assay":"X1","conclusion":"KRAS-G12C detected","closure":["A1","B1","S1","X1"],"attested":true,"issuedAt":"2026-01-01T06:00:00.000Z"}
summary: {"VALID":1,"BROKEN":0,"STALE":0,"PENDING":0}
$ # after revoking the upstream sample S1
BROKEN	X1	revoked node S1 (consent withdrawn) in derivation chain
  broken-core: {"kind":"revoke","chain":["S1","A1","X1"]}
summary: {"VALID":0,"BROKEN":1,"STALE":0,"PENDING":0}
$ # compact, then verify again (identical verdict)
compacted 6 events -> 1 snapshot event
BROKEN	X1	revoked node S1 (consent withdrawn) in derivation chain
  broken-core: {"kind":"revoke","chain":["S1","A1","X1"]}
summary: {"VALID":0,"BROKEN":1,"STALE":0,"PENDING":0}
$ # audit budget exhausted -> PENDING (not BROKEN)
PENDING	X1	audit budget 0 exhausted
summary: {"VALID":0,"BROKEN":0,"STALE":0,"PENDING":1}
