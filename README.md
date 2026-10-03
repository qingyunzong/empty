# settlement

Offline securities settlement library and CLI. Node.js 22, standard library only, tested with `node:test`.

## CLI

```
node . deliver input.json output.json
```

Exit code `1` for unreadable/invalid JSON or single-sided instructions (buys only or sells only); `0` otherwise. The WAL lives at `input.walPath` or `<output>.wal`.

## Input

```json
{
  "accounts": [{"id": "C1", "cash": 1000, "positions": {"AAA": 50}}],
  "instructions": [{"id": "B1", "side": "buy", "security": "AAA", "price": 10, "quantity": 50, "accounts": ["C1"]}],
  "permissions": [["B1", "S1"]],
  "cancellations": ["S2"],
  "walPath": "state.wal"
}
```

- `accounts`: available cash and per-security positions. `accounts` on an instruction restricts its candidate settlement accounts.
- `permissions`: allowed `[buyId, sellId]` pairs; omitted means any pair with equal security/price/quantity.
- `cancellations`: instruction ids to cancel in this run.

## Matching rules

- A buy and a sell pair only when security, price and quantity are equal and the pair is permitted.
- Each instruction appears in at most one pair; the buyer's account must cover `price*quantity` cash, the seller's account the full position.
- Matching freezes the buyer's cash and the seller's securities. Cancellation unfreezes first, then breaks the pair.
- Re-runs are incremental: pairs already in the WAL stay fixed, only unmatched instructions are re-matched.

## Solver

- Propagation deletes impossible accounts from each instruction's domain (`buildDomains`), forward checking prunes during search.
- Backtracking with MRV finds a matching (`findMatching`); `enumerateMatchings` enumerates all pairings (acceptance scenarios use <=4 instructions).
- On UNSAT, `explainConflict` finds the minimal infeasible instruction set and reports the shortest instruction cycle contending for one shared resource (account cash, account position, or counterparty).

## WAL and crash recovery

Append-only JSONL log with `match` / `cancel` / `unfreeze` / `unpair` records. All state is rebuilt by replaying the WAL, so restarts never freeze funds twice. The defined crash point is "match log written, unfreeze log not written": on restart `recover()` completes the missing unfreeze and rolls back the pair (appends `unfreeze` then `unpair`), idempotently.

## Tests

```
node --test
```

Covers: two-pair settlement, cancellation + incremental re-matching, WAL crash recovery, UNSAT on insufficient balance, domain propagation, matching enumeration, and CLI exit codes.
