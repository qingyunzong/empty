# MES Offline Event Cache (injection molding)

Node.js 22, standard library only, offline single-machine. Caches production
events arriving over an unreliable link (duplicates, out-of-order, late),
rebuilds per-lot unit chains, and issues append-only quality certificates.

## Event model

Each JSONL line is one event:

```json
{"lot":"L1","mold":"M1","station":"S1","seq":1,"ts":1000,"kind":"produce","qty":100,"hash":"h1"}
```

- `kind`: `produce` (source), `split` (1 parent), `merge` (>=2 parents), `correct` (late correction)
- `parents`: seq list of parent events in the same lot+mold (required for split/merge)
- `future`: optional boolean; corrections may only replace `future=false` events
- `correct` carries `target` (the seq it replaces) plus the new `qty`/`hash`/`ts`

## Semantics

- Dedup by `(lot, mold, station, seq)`: identical hash = duplicate (dropped);
  different hash = conflict (first wins; only `kind=correct` rewrites).
- Missing interior seqs are NAKed until `now - refTs >= deadline` (boundary
  inclusive), then marked as gaps. Gaps never block later available batches.
- Canonical chain: per lot, events topologically ordered by valid seq
  (parent seq < child seq is enforced at validation).
- Conservation: split children qty sums to the parent qty; a merge event's qty
  equals the sum of its parents and must be their sole child.
- Certificates: one active cert per lot (`sha256` over the canonical chain).
  A correction revokes the current cert (append-only, never mutated) and
  issues a new version with a different hash.

## Usage

```sh
node cli.js events.jsonl --now 5000 [--deadline 1000]
```

Output (stdout, JSON): `chain`, `gaps`, `naks`, `certificates`,
`corrections`, `stats`.

Exit codes: `0` ok, `2` invalid input/args, `4` qty conservation violation.

## Tests

```sh
node --test
```

Covers: out-of-order + duplicate delivery vs sorted reference; late
correction revoking the old cert with a changed hash; deadline boundary
(`now - refTs == deadline` times out exactly); all 40320 permutations of
seq 1..8 deduping to the identical chain; CLI exit codes 0/2/4.
