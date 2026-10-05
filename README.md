# certpath-cli

Offline certificate path validation over a **local certificate relationship
graph** with **explicit per-certificate verification results**. No network
access is used or required; only Node.js built-in modules are used at runtime.

## Path rules

Given a leaf certificate and a requested usage, a valid path is a simple
chain of certificates `leaf -> ... -> root` such that:

1. every certificate on the chain is **valid** per the explicit verification
   results in the input (`validity`),
2. every certificate on the chain **allows the requested usage** (the usage
   intersection along the chain contains the requested usage),
3. the chain **ends at a trusted root** (`trustedRoots`),
4. the chain contains **at most 12 certificates** (default; override with
   `--max-length`).

Among all valid paths the **shortest** wins; ties are broken by
**certificate id order** (lexicographic comparison of the id sequence).

When no valid path exists, the tool reports a deterministic failure reason:
`LEAF_NOT_FOUND`, `LEAF_INVALID`, `LEAF_USAGE_MISMATCH`,
`NO_TRUSTED_ROOT_REACHABLE`, `PATH_TOO_LONG`, `CERT_INVALID`, or
`USAGE_MISMATCH` (the last two name the offending certificate).

## Input format

A single local JSON file:

```json
{
  "certificates": [
    { "id": "leaf", "issuers": ["ca-a", "ca-b"], "usages": ["serverAuth"] }
  ],
  "validity": { "leaf": true, "ca-a": true },
  "trustedRoots": ["root-a"]
}
```

- `certificates[].issuers`: candidate issuers (a certificate may be
  cross-signed by several CAs); `[]` for a self-contained root.
- `validity`: explicit verification result for **every** certificate
  (missing entries are rejected at load time).
- `trustedRoots`: ids of trust anchors; each must be a known certificate.

## Usage

```sh
npm run build
node dist/src/cli.js <input.json> --leaf <id> --usage <usage> [--max-length <n>] [--json]
```

Exit codes: `0` path found, `1` no valid path, `2` bad invocation or input.

Example (see `fixtures/sample.json`):

```sh
$ node dist/src/cli.js fixtures/sample.json --leaf leaf --usage serverAuth
OK path (3 certificates): leaf -> ca-a -> root-z
```

## Design

- `src/model.ts` — input parsing and validation (graph, explicit results).
- `src/pathfinder.ts` — main search: breadth-first by path length with
  incremental pruning (validity, usage, cycles, length cap); within a depth
  level candidates expand in id-sequence order, so the first accepted path
  is shortest with id-order tie-break. Also contains `diagnose()`, which
  inspects the best structural chain to a trusted root and reports the first
  violated constraint.
- `src/enumerate.ts` — reference implementation: brute-force enumeration of
  every simple issuer chain, then filter and sort. The randomized
  cross-check in `test/crosscheck.test.ts` asserts both implementations
  agree on 900 generated graphs/requests.
- `src/cli.ts` — argument parsing (`node:util` `parseArgs`) and output;
  `run(argv, io)` is exported so tests can drive the CLI in-process.

## Tests

```sh
npm test
```

Covers: path finding, shortest-path and id-order tie-breaks, the 12/13
certificate boundary, every failure code, issuer-cycle termination, input
validation, CLI behaviour, and the randomized cross-check against simple
path enumeration. Actual recorded output: see `RESULTS.md`.
