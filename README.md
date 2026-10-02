# stratified-audit-sampler

Deterministic, reproducible, verifiable stratified sampling for settlement
ledger audits. Pure Node.js 22 standard library; tests use `node:test`.

## Mechanisms

- **Deterministic selection**: each record's key is
  `sha256("sample|" + seed + "|" + stratum + "|" + recordId)`. Per stratum,
  records are sorted by key and the first `quota` are drawn — a simple random
  sample without replacement that is a pure function of
  `(seed, stratum, population)`. Same version + same seed ⇒ same sample.
- **Concurrent history**: ledger records are resolved per `id` by the total
  order `(version, source, seq)`. Diverging payloads at identical metadata
  raise `VERSION_CONFLICT`. Arrival order never affects the outcome.
- **Incremental re-sampling**: with a `--state` file, each stratum keeps its
  certificate while its `populationHash` and quota are unchanged. Only
  affected strata (revocation, correction, quota change, seed change) are
  re-sampled; superseded certificates are kept in state history as
  `SUPERSEDED` and reported in `invalidated` with their old `stratumRoot`
  and `populationHash` as the invalidation proof — never deleted.
- **Verifiability**: certificates are self-contained (population +
  content hashes + selection keys). `verify` recomputes keys, selection,
  per-stratum merkle roots and the composed `merkleRoot`.

## CLI

```
node cli.js sample [--state <path>] [--file <request.json>]   # stdin if no --file
node cli.js verify [--file <certificate.json>]
```

Reads JSON, writes JSON to stdout. Any failure prints
`{"error":{"code","message","details"}}` and exits with code 2.

### Request

```json
{
  "seed": "audit-seed-1",
  "version": 2,
  "computeBudget": 100000,
  "strata": [{ "id": "retail", "quota": 2 }],
  "ledger": [
    { "id": "tx-1", "stratum": "retail", "version": 1, "source": "nodeA", "seq": 1, "amount": 100 }
  ],
  "revocations": ["tx-9"]
}
```

### Output

`samples` (per-stratum population, selected records, `stratumRoot`),
`merkleRoot` (composed over strata), `invalidated` (superseded-certificate
proofs), `quotaUse` (per-stratum quota/population/drawn, `hashEvaluations`,
`computeBudget`).

### Error codes

| Code              | Cause                                                        |
|-------------------|--------------------------------------------------------------|
| `SEED_REQUIRED`   | missing/empty `seed`                                         |
| `QUOTA`           | quota > population, or `computeBudget` exceeded              |
| `VERSION_CONFLICT`| same `(version, source, seq)` with diverging payloads        |
| `STRATA_MISSING`  | quota/ledger strata mismatch; gaps listed, never empty-treated |

## Library

```js
const { runSample, verifyCertificate, loadState, saveState } = require('./src');
const { output, state } = runSample(request, priorStateOrNull);
const { valid, checks } = verifyCertificate(output);
```

## Tests

`node --test` — covers determinism, quota boundaries (0, =population,
>population, budget boundary), all four error codes, revocation/correction
incremental re-sampling with SUPERSEDED proofs, concurrent version
resolution, CLI end-to-end (exit code 2 on failure), and an independent
brute-force enumeration cross-check for all n ≤ 12, k ≤ n.

Latest run on this machine: 8/8 test files pass, 0 failures
(`# pass 8 / # fail 0`, ~38s; the sandbox makes subprocess spawning slow).
