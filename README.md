# Chain-of-Evidence Audit (clinical-omics core facility)

Node.js 22, standard library only. Tests: `node --test`.

Every assay conclusion is backed by an auditable evidence chain from sample
collection to sequencer. `verify` decides, per conclusion:

- **VALID** — complete, unexpired, unrevoked chain; a certificate is issued.
- **BROKEN** — a constraint failed; a minimal, re-checkable broken core is printed.
- **STALE** — cold-chain time limit (72h) exceeded and not preserved by attestation.
- **PENDING** — audit budget exhausted before the closure was fully checked.
  PENDING is not BROKEN (exit code stays 0).

## Events

`register` (sample|batch), `aliquot`, `assay`, `qc_fail`, `revoke`, `attest`,
plus `snapshot` (produced by `compact`). Logs are JSONL.

## Constraints

- **Volume conservation** — aliquots drawn from a parent may not exceed its volume.
- **Cold-chain limit** — 72h max per derivation edge and for root-sample age at
  audit time; an attestation made while the chain was fresh preserves it.
- **Batch/reagent compatibility** — an assay's reagent must be in its batch's
  compatibility list.
- **QC gating** — any `qc_fail` in the derivation closure breaks the conclusion;
  the reported core is the shortest path from the failed node to the assay.
- **Revocation contagion** — `revoke` invalidates everything downstream along
  derivation edges. Attested conclusions survive only if their closure contains
  no revoked node.

## Compact & crash safety

`compact` folds the log into one `snapshot` event. `verify` is a pure function
of folded state, so results are identical before and after. Failure points:
write `<log>.tmp` → `fsync(tmp)` → atomic `rename` → `fsync(dir)`. A commit
sentinel (`{"type":"end"}`) terminates the tmp payload. After a crash,
`recover` yields exactly one of: the old complete log (torn tmp discarded) or
the new complete log (complete tmp installed).

## CLI

```
node bin/cli.js register <log> --id S1 --kind sample --volume 100 --time <iso>
node bin/cli.js register <log> --id B1 --kind batch --reagent R1 [--compatible R1,R2]
node bin/cli.js aliquot  <log> --id A1 --parent S1 --volume 40 --time <iso>
node bin/cli.js assay    <log> --id X1 --parent A1 --batch B1 --reagent R1 --conclusion "..." --time <iso>
node bin/cli.js qc_fail  <log> --target A1
node bin/cli.js revoke   <log> --target S1 --reason "..."
node bin/cli.js attest   <log> --target X1 --signature sig:...
node bin/cli.js verify   <log> [--budget N] [--now <iso>]   # exit 1 iff any BROKEN
node bin/cli.js compact  <log>
node bin/cli.js recover  <log>
```

## Layout

- `src/state.js` — event folding + constraint checks (violations recorded, not thrown)
- `src/closure.js` — derivation closure (BFS + fixpoint, cross-checked by tests)
- `src/verify.js` — verdict engine + brute-force reference implementation
- `src/logio.js` — JSONL IO, atomic compact, recover
- `bin/cli.js` — command-line interface
- `test/` — acceptance tests (see RESULTS.md for real output)
