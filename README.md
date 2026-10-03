# netclear

Multi-currency bilateral payment netting with frozen-limit and clearing-window
capacity constraints, versioned FX rates, and reversible incremental
recomputation. Pure Node.js 22 standard library; tests use `node:test`.

## Model

- **Trade** `{id, from, to, ccy, amount}` — `from` owes `to` `amount` minor
  units of `ccy` (positive safe integer).
- **Rates** — versioned table, integer rates scaled by 1e6 (`1.10` →
  `1100000`), the base currency fixed at `1000000`. Conversion to base uses
  exact BigInt arithmetic, rounding half-up, so it is fully deterministic.
- **Limits** — per-participant frozen limit in base currency. `limits: null`
  means unlimited; a participant missing from the map has limit `0`.
- **Capacity** — clearing-window capacity: maximum total frozen amount per
  window. `null` means unlimited.

## Settlement pipeline (rules version `netting-rules/1.0.0`)

1. Convert every active trade to base currency.
2. Aggregate per ordered pair, then offset opposite directions of every
   unordered pair (bilateral netting).
3. Detect elementary cycles; repeatedly cancel the canonically first cycle by
   its minimum edge until the residual graph is acyclic. A pending cycle is
   never treated as unsatisfiable: a balanced cycle nets to zero and needs no
   liquidity at all.
4. Net position per participant = residual in − residual out (invariant under
   any netting order). Each net payer freezes `lock = max(0, −net)`.
5. Constraint checks, in canonical participant order:
   - `lock > limit` and the participant sits on a cycle of the pre-cancellation
     graph → **CYCLE_LOCKED**; `details.conflictSet` lists the trade ids of the
     shortest simple cycle through that participant (minimal: removing any one
     of them breaks the cycle).
   - `lock > limit` outside any cycle → **LIMIT**.
   - `Σ locks > capacity` → **LIMIT** with `details.scope = "window"`.
   - Boundary is inclusive: `lock == limit` and `Σ locks == capacity` settle.

## Incremental recomputation

The engine partitions the trade graph into connected components and caches
each component's netting result.

- `correctRates({ccy: rate})` registers a new rate version (`latest + 1`) and
  recomputes **only** components containing a trade in a changed currency.
- `voidTrade(id)` marks a trade voided and recomputes **only** the affected
  component; reduced locks are released through the lock ledger.
- Every state change appends lock/release events; `replayEvents(events)`
  rebuilds the frozen balances from an empty ledger, so releases after a void
  are replayable. A release exceeding the locked balance (corrupt/duplicated
  log) raises **NEGATIVE_RELEASE**.
- `lastRun.recomputedComponents` and `componentStats` expose exactly which
  components were recomputed.

## Error codes

| Code | Meaning |
| --- | --- |
| `RATE_STALE` | Settling with, or registering, a non-latest rate version |
| `LIMIT` | Frozen limit or window capacity exceeded (acyclic) |
| `CYCLE_LOCKED` | Unnettable cycle; `details.conflictSet` = minimal conflict set |
| `NEGATIVE_RELEASE` | Release larger than the locked balance |
| `INVALID_INPUT` | Schema/validation errors |

## Determinism & proof

Same trades + same rate version ⇒ byte-identical output. All iteration orders
are canonical (sorted ids); cycle cancellation always takes the
lexicographically first cycle. Output `proof` contains `inputHash`
(SHA-256 of the canonical JSON of trades, voids, limits, capacity, rates and
rules version), `rulesVersion`, `ratesVersion` and the algorithm id.

## CLI

```
node cli.js trades.json rates.json
```

- `rates.json`: `{base, versions: [{version, rates: {CCY: scaled}}, ...]}`
- `trades.json`: `{trades: [...], limits?: {P: amount}, capacity?: number,
  ratesVersion?: number, void?: [tradeId]}`

Prints canonical JSON to stdout: `{status, netPositions, locks, residualFlows,
cycles, window, proof}` or `{status: "error", error: {code, message,
details}}`. Exit codes: `0` ok, `1` clearing error (LIMIT / CYCLE_LOCKED /
RATE_STALE / NEGATIVE_RELEASE), `2` invalid input.

## Tests

```
node --test    # or: npm test
```

Covers: netting and cycle reduction, determinism under input shuffling, limit
and capacity boundaries (exact equality accepted), CYCLE_LOCKED conflict sets,
incremental scope of rate corrections and voids, release replay and
NEGATIVE_RELEASE, RATE_STALE, CLI behaviour, and a randomized cross-check
(n ≤ 8 trades, 300 seeds) of net positions and bilateral offsets against a
brute-force enumeration, plus 101 randomized void scenarios.
