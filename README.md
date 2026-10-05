# factory-line-scheduler

Offline single-machine factory scheduler. A scheduler (sender) syncs the daily
plan to a line terminal (receiver) over a confirmation protocol:
commands `PLAN` / `MOVE` / `CANCEL` carry `id`, `ver`, `cost`; the terminal
replies `ACK` / `NAK`. Node.js 22, standard library only, tests via `node:test`.

## Run

```sh
node cli.js ops.json --cap 100 --seed 7 [--loss 0.4] [--base-timeout 4] [--max-retries 8]
node --test
```

`ops.json` is an array of commands (or `{ "ops": [...] }`):

```json
{ "op": "PLAN",   "id": "A", "ver": 1, "cost": 40, "start": 8, "end": 10 }
{ "op": "MOVE",   "id": "A", "ver": 2, "cost": 20, "start": 9, "end": 11 }
{ "op": "CANCEL", "id": "A", "ver": 3 }
```

Output (stdout, JSON): `plan` (confirmed jobs sorted by `(start, id)`
lexicographic), `ledger` (confirmed budget flow with running `used`),
`pending` (unconfirmed retransmit queue), `remaining` (unprocessed ops after
a failure), `stats` (retransmissions, dedup counters, channel drops).

Exit codes: `0` ok · `1` internal · `2` usage/IO · `3` protocol error ·
`5` budget insufficient (state unchanged).

## Protocol

- **Stop-and-wait ARQ**: one unconfirmed command at a time. On timeout the
  scheduler retransmits with exponential backoff (`timeout *= 2`, base 4
  ticks) up to `maxRetries`; beyond that the run aborts with a protocol
  error (exit 3).
- **Lossy channel**: each transmission (command or ACK) is dropped with
  probability `--loss`, driven by a seeded mulberry32 PRNG (`--seed`), so
  runs are reproducible. Tests can inject a fully scripted channel.
- **Dedup**: the terminal applies each `id@ver` at most once — a retransmit
  after a lost ACK replays the cached ACK and never re-charges the budget;
  the scheduler drops duplicate ACKs. A retransmitted `id@ver` with a
  *different* payload is a protocol error.
- **Ordering**: `ver` is monotonic per `id`; the terminal silently ignores
  commands with a lower `ver` than the highest ACKed one.

## Budget & transactions

- Daily cap `--cap`; `PLAN` occupies `cost`, `CANCEL` releases it, `MOVE` is
  atomic: release the old occupancy, then occupy the new one inside a single
  transaction — if the occupy fails, the release rolls back and the old
  occupancy is retained.
- The ledger supports hierarchical (nested) transactions. `rollback()`
  undoes exactly the innermost unconfirmed frame; once a frame is confirmed
  (ACKed) its entries are immutable and rollback with no open frame is
  refused.
- Any failed step rolls the command back to its pre-command state without
  touching already-confirmed commands. A budget `NAK` stops the run with
  exit 5 and the state exactly as before the failed command.

## Layout

- `cli.js` — CLI entry (exports `main(argv, io)` for in-process testing)
- `src/ledger.js` — budget ledger with nested transactions
- `src/terminal.js` — receiver: validation, dedup, stale-ver ignore, ACK/NAK
- `src/scheduler.js` — sender: stop-and-wait, backoff, ACK dedup
- `src/channel.js` — seeded lossy channel + scripted channel for tests
- `src/simulator.js` — event loop wiring scheduler ↔ channel ↔ terminal
- `src/validate.js`, `src/errors.js`, `src/prng.js`
- `test/` — acceptance tests; `examples/ops.json` — sample input

## Verified results (this machine, Node v22.22.1)

```
$ node --test
ok 1 - test/cli.test.js
ok 2 - test/exhaustive.test.js
ok 3 - test/ledger.test.js
ok 4 - test/move.test.js
ok 5 - test/protocol.test.js
# pass 5  # fail 0

$ node cli.js examples/ops.json --cap 100 --seed 7   → exit 0, used 70
$ node cli.js over.json  --cap 100                   → exit 5, used 80 (unchanged), remaining: PLAN
$ node cli.js bad.json   --cap 100                   → exit 3 (CANCEL: unknown job GHOST)
$ node cli.js examples/ops.json --cap 100 --seed 42 --loss 0.4 → exit 0, used 70, retransmissions 5
```

Acceptance coverage:

1. `test/protocol.test.js` — lost ACK → retransmit → budget charged once
   (scripted channel drops transmission #1); backoff waits 4/8/16 ticks;
   duplicate ACK dedup; stale ver ignored.
2. `test/move.test.js` — MOVE over budget keeps the old occupancy, no ledger
   trace of the failed command.
3. `test/ledger.test.js` — nested unconfirmed transactions roll back level
   by level; rollback of ACKed history is refused.
4. `test/exhaustive.test.js` — all 1554 command sequences of length ≤ 4 over
   a 6-template alphabet checked against a brute-force budget reference
   (ok / budget-NAK / protocol-error outcomes and final state all match).
