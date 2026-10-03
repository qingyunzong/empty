# offline-pay-ledger

Offline payment settlement library + CLI with a write-ahead log (WAL).
Node.js 22, standard library only, tests via `node:test`.

## WAL format

Each frame: `length(4B LE) | seq(4B LE) | crc32(4B LE) | payload(JSON)`.
CRC32 (IEEE) covers `length | seq | payload`.

Commit protocol: append the change record (`PAY`/`CANCEL`), then append
`COMMIT`, then `fsync`, then return success to the client.

Recovery on open: scan frames; stop and discard the tail at the first CRC
mismatch, truncated frame, or bad JSON; redo committed transactions; drop
change records without a matching `COMMIT`. The merchant index and balances
are rebuilt entirely from the WAL.

## CLI

```
node cli.js [--wal PATH] pay --merchant M --amount CENTS [--id TXN]
node cli.js [--wal PATH] cancel --txn TXN
node cli.js [--wal PATH] audit --merchant M
node cli.js [--wal PATH] recover
node cli.js [--wal PATH] crash --point P1|P2 --merchant M --amount CENTS [--id TXN]
```

- `crash --point P1`: exits (code 75) after the change record, before COMMIT.
- `crash --point P2`: exits (code 75) after COMMIT + fsync, before the reply.
- Errors are printed as JSON (`{"error":{"code","message"}}`) on stderr with
  a non-zero exit code, e.g. `E_ALREADY_CANCELLED`, `E_TXN_NOT_FOUND`.

## Library

```js
const { Ledger } = require('./src/ledger');
const ledger = new Ledger('ledger.wal').open();
ledger.pay({ merchant: 'm1', amount: 1000 });
ledger.cancel({ txnId: 'tx_1' });
ledger.audit('m1'); // { merchant, balance, entries }
```

## Tests

```
node --test
```
