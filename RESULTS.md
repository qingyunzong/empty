# RESULTS — provenance-audit

Environment: Node.js v22.22.1, standard library only, offline. Test runner: `node --test`.
Date: 2026-10-08. All results below are real command output from this workspace.

## Unit / property tests (`node --test`)

```
ok 1 - reach: valid certificate verifies as VALID
ok 2 - reach: modifying any edge in the certificate fails
ok 3 - reach: modifying the underlying graph edge invalidates version binding
ok 4 - reach: missing chain layer, fake path, and reordered edges are rejected
ok 5 - nonreach: valid certificate verifies as VALID
ok 6 - nonreach: deleting a boundary edge from the certificate fails
ok 7 - nonreach: deleting an edge from the graph gives VERSION_MISMATCH
ok 8 - nonreach: shrinking or growing the reachable set is rejected
ok 9 - nonreach: proves fail when a path actually exists
ok 10 - contamination: locates the first contaminated edge among multiple sources
ok 11 - property: provers agree with BFS ground truth on random graphs n<=9
ok 12 - boundary: empty graph yields NO_SUCH_NODE on verify and errors on prove
ok 13 - boundary: self-loops are handled (trivial and looped paths)
ok 14 - boundary: duplicate proof ids are deterministic; forged ids rejected
ok 15 - boundary: malformed certificates are CERT_INVALID, never crash
ok 16 - timeout: exhausted step budget raises PROVE_TIMEOUT, not NO_PATH
ok 17 - scale: n=500, m=5000 proves and verifies quickly

# pass 17  # fail 0
```

## Acceptance mapping

1. **Path cert passes; changing any edge fails** — tests 1–4: `prove_reach` cert is
   VALID; flipping either endpoint of any certified edge, dropping a hash-chain
   layer, faking a shortcut edge, or swapping chain links all yield CERT_INVALID;
   changing the underlying graph edge set yields VERSION_MISMATCH.
2. **Non-path cert passes; deleting a boundary edge fails** — tests 5–8: cert VALID;
   removing any boundary edge from the cert → CERT_INVALID; deleting the edge in
   the graph → VERSION_MISMATCH; shrinking/growing the reachable set → CERT_INVALID.
3. **Multi-source contamination** — test 10 plus CLI demo below: first contaminated
   edge located deterministically (shortest path, lexicographic tie-break).
4. **n<=9 vs BFS enumeration** — test 11: 60 seeded random graphs (n=1..9, incl.
   self-loops), all s/t pairs cross-checked against BFS ground truth.
5. **Boundaries** — tests 12–15: empty graph → NO_SUCH_NODE; self-loops (zero-length
   path cert verifies); duplicate proof ids are deterministic/idempotent, forged ids
   rejected; malformed certs never crash.

Timeout safety (test 16): an exhausted step budget raises `PROVE_TIMEOUT`
(CLI exit 3) and is never reported as `NO_PATH` (CLI exit 2).

## CLI end-to-end run (real output)

Graph: RAW1→MIX_A→PROD→SHIP, RAW2→MIX_B→PROD, plus isolated CLEAN with self-loop.

```
$ node cli.js build --nodes nodes.json --edges edges.json
{"version":"963381a59852c76f37f96f26b440208bb5e3f923f4c253b4c7a8462dd1aa404a","nodes":7,"edges":6,"file":".audit/graph.json"}

$ node cli.js prove_reach --s RAW1 --t SHIP --out reach.json && node cli.js verify --proof reach.json
VALID                                    (exit 0)

$ node cli.js prove_nonreach --s CLEAN --t PROD --out nonreach.json && node cli.js verify --proof nonreach.json
VALID                                    (exit 0)

$ node cli.js contaminate --sources RAW1,RAW2 --t SHIP
{"source":"RAW1","path":["RAW1","MIX_A","PROD","SHIP"],"firstEdge":["RAW1","MIX_A"]}

# tampered cert (one hash-chain layer removed):
$ node cli.js verify --proof bad.json
CERT_INVALID                             (exit 1)

# stale certs after graph rebuild with extra edge RAW2→PROD:
$ node cli.js verify --proof reach.json
VERSION_MISMATCH                         (exit 1)
$ node cli.js verify --proof nonreach.json
VERSION_MISMATCH                         (exit 1)

# error channels kept distinct:
$ node cli.js prove_reach --s RAW1 --t GHOST      → ERROR: no such node: "GHOST"  (exit 4)
$ node cli.js prove_reach --s SHIP --t RAW1       → ERROR: NO_PATH                (exit 2)
$ node cli.js prove_reach --s RAW1 --t SHIP --max-steps 2
                                                  → ERROR: PROVE_TIMEOUT          (exit 3)
```

## Scale check

n=500 nodes, m=5000 edges: build + reach/nonreach prove + verify complete in
well under 1 s (covered by test 17, BFS-based, O(n+m)).
