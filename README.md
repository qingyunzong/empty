# Settlement Audit Ledger

Chunked append-only audit ledger for settlement streams (deposits, refunds,
transaction cancels, fee settlements). Node.js 22, standard library only.

## Storage layout

A store is a directory (`--dir`, default `./ledger`):

- `ledger.dat` — fixed-size slots. Slot 0 is the superblock (magic, slot
  size). Each later slot is one chunk: magic, chunk index, previous chunk
  SHA-256, event count, payload length, end offset, CRC32 (header + payload),
  then JSONL events, zero-padded to the slot boundary.
- `index.json` — global locator: account -> chunk offsets, tx -> chunk offset
  (covers every chunk whose events still decode).
- `state.json` — balances/fees/cancellations of confirmed chunks only.
- `quarantine.json` — quarantined and pending chunk lists.

Zero padding at the end of `ledger.dat` is an unfinished tail, not corruption:
`rebuild` truncates it and reports the truncated slot count.

## Integrity model

- Chunks form a hash chain (`prevHash` = SHA-256 of the previous slot).
- The first chunk failing CRC/chain checks is **quarantined**; every later
  chunk is **pending** (chain broken) even if its own CRC is valid.
- State only ever reflects confirmed chunks before the quarantine point.
- `find --tx` uses the index to decode only the located chunk(s); it never
  scans unrelated chunks.

## Business rules

- Event types: `deposit`, `refund`, `fee`, `cancel` (integer minor units).
- A refund that would drive an account's net balance negative is rejected.
- A cancel must link to an existing, not-yet-cancelled original event and
  reverses its effect.

## CLI

```
node cli.js append     --dir D [--slot-size N] --event '{"type":"deposit",...}'
node cli.js audit      --dir D
node cli.js find       --dir D --tx TX | --account ACCT
node cli.js cancel     --dir D --tx TX
node cli.js quarantine --dir D
node cli.js rebuild    --dir D
```

All commands print JSON. Exit codes: `0` ok, `1` business error, `2`
corruption.

## Tests

```
node --test
```
