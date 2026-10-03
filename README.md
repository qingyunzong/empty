# trade-order

Event-sourced trade ordering library + CLI (Node.js 22, stdlib only).

## Model

An instruction (`tradeId`, `amount`, `riskResult`, `accountResult`) drives two
parallel branches: risk approval and account freeze. The join happens only
after both branch events arrive: both pass -> `confirm`; either fails ->
`cancel` + unfreeze. Every event is appended to `<workdir>/events.jsonl`
before state is mutated, so a restart replays the log and finishes any
pending join exactly once (`crashBeforeConfirm` simulates a crash between
branch persistence and confirmation). Events are idempotent by event `id`
and by `tradeId`; branches may arrive out of order or duplicated.

## CLI

```
node cli.js '<event-json>' <workdir>
```

Prints a certificate `{"ok",...,"stateHash"}` on success. On failure exits
with code 1 and prints `{"error":"CODE","message":"..."}`.

Event types: `instruction`, `risk`, `account`, `finalize`.

## Test

```
node --test
```
