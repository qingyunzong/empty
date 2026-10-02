# ebr-chain

Offline aggregation of aseptic-filling electronic batch records (EBR).
Node.js 22, standard library only, no network, no external keys — integrity
comes from a sha256 hash chain plus vector causality.

## Model

Each record is one JSONL line:

```json
{"v":1,"site":"A","seq":3,"epoch":1,"type":"step","prev":"<sha256>","vc":{"A":3,"B":1},"payload":{...},"target":null,"scope":null,"hash":"<sha256>"}
```

- `prev` — sha256 of the site's previous record (per-site hash chain, `null` at genesis).
- `vc` — vector clock: everything the site had causally observed, itself included.
- `epoch` — site membership epoch; non-decreasing along a site's chain.
- `type` — `step` | `deviation` | `revoke` | `exit`.

`hash` = sha256 of the canonical JSON (sorted keys) of the record without `hash`.

### Tombstones

A `revoke` record points at `target` and states its `scope`. It never rewrites
history: the chain is append-only and shadowed records stay auditable.
A revoke can itself be revoked, but only by a **strictly higher epoch**;
an equal-or-lower-epoch revoke of a revoke is inert (deterministic boundary).

### Site exit

An `exit` record retires a site at epoch E. Later records from that site with
`epoch <= E` are rejected as low-epoch backfill (exit code 16); epochs must
also be non-decreasing along each site chain. History is always retained.

## Verifier certificate

`verify` emits:

- `head` — sha256 committing to the canonical causal order of all records.
- `missing` — gaps only: dropped seqs, dangling `prev`/`vc` references,
  revoke targets not present. Missing data yields `status: "unknown"`;
  it is **never** judged non-compliant.
- `shadowed` — records hidden by active tombstones, still fully auditable.

Exit codes: `0` ok/unknown · `15` broken hash chain · `16` low-epoch backfill · `2` usage/IO.

## CLI

```sh
node bin/cli.js append --log a.jsonl --site A --epoch 1 --type step --payload '{"step":"fill"}'
node bin/cli.js append --log a.jsonl --site A --epoch 1 --type revoke --target <hash> --scope record
node bin/cli.js merge --out merged.jsonl c.jsonl a.jsonl b.jsonl   # any input order
node bin/cli.js verify merged.jsonl                                # certificate to stdout
node bin/cli.js export --out certificate.json merged.jsonl         # certificate to file
```

## Tests

```sh
node --test        # runs the whole suite (npm test is equivalent)
```

Coverage: three-site out-of-order merge replay, revoke-of-revoke epoch
boundary, missing-gap reporting without failure judgement, and a seeded
property test (random ≤9-step runs checked against independent
linear-extension enumeration), plus exit-code 15/16 paths.
