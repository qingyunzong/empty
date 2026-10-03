# smt-frame-gateway

Gateway that reassembles binary inspection frames from a pick-and-place (SMT)
machine and issues verifiable quality certificates. Node.js 22, standard
library only, offline, single machine. Tests use `node:test`.

## Frame format (big-endian)

| Offset | Size | Field                                        |
|-------:|-----:|----------------------------------------------|
| 0      | 2    | magic `0xAA55`                               |
| 2      | 2    | `len` = payload bytes                        |
| 4      | 1    | `type`: `0x01` DATA, `0x02` END, `0x03` ABORT |
| 5      | 2    | `board` id                                   |
| 7      | 2    | `session` id                                 |
| 9      | 4    | `offset` (DATA only, 0 otherwise)            |
| 13     | len  | payload (ABORT may carry a UTF-8 reason)     |
| 13+len | 4    | CRC-32 (IEEE) over bytes `[0, 13+len)`       |

## Semantics

- DATA fragments may arrive out of order; retransmits are deduped by `offset`
  (identical bytes only — an overlapping mismatch is a structural error).
- Gaps trigger `retransmit_request` events after `--missing-timeout-ms`
  (default 1000) on an injectable, pausable clock (`lib/clock.js`).
- END commits the board: a certificate with the Merkle root (sha256 over
  1024-byte chunks, odd nodes duplicated), `receivedBytes`, `retransmits`,
  `discardReason: null`. END with gaps is a structural error.
- ABORT discards the board's current session and records an `aborted`
  certificate with the discard reason and bytes received so far.
- ABORT after END is ignored. After a terminal state (END/ABORT) a new run on
  the same board must use a strictly greater `session`, otherwise it is a
  conflict: the run stops, the old certificate is kept, exit code 6.
- Bad CRC frames are logged as `bad_crc` and skipped; processing continues.
- Structural errors (bad magic, unknown type, END with payload, empty DATA,
  overlapping mismatch, truncated tail) stop the run with exit code 2.
- `certs.json` is always flushed atomically (tmp + rename), so committed
  certificates survive a crash mid-frame (`truncated_tail`).

## Usage

```sh
node cli.js --stream s.bin --out certs.json          # frames.log written alongside
node cli.js --stream s.bin --out certs.json --frames-log frames.log --missing-timeout-ms 500
node tools/gen_stream.js --out s.bin --scenario ok   # ok|abort|conflict|truncated|badcrc
node --test                                          # run the test suite
```

Exit codes: `0` ok, `2` structural error, `6` session conflict.

## Library

```js
const { Gateway } = require('./lib/gateway');
const { VirtualClock } = require('./lib/clock');
const clock = new VirtualClock();          // or RealClock
const gw = new Gateway({ clock, missingTimeoutMs: 1000, onEvent: console.log });
gw.feed(buf);                              // incremental, any chunking
gw.end();                                  // throws StructuralError on truncated tail
gw.certs();                                // committed/aborted certificates
clock.pause(); clock.advance(1000);        // virtual time control
```

## Verified results (recorded 2026-10-04, Node v22.22.1)

`node --test` — 4 files, all pass (≈8 s):

- `test/frame.test.js` — CRC-32 known vector, encode/parse roundtrip, structural errors
- `test/gateway.test.js` — acceptance 1/2/3, bad-CRC healing, retransmit timeout, paused clock
- `test/fuzz.test.js` — acceptance 4: 200 random chunkings + all 2^11 enumerated offset splits vs one-shot reference root
- `test/cli.test.js` — exit codes 0/2/6, output files, cert preservation

CLI runs (`tools/gen_stream.js --seed 7`):

| scenario  | exit | result                                             |
|-----------|-----:|----------------------------------------------------|
| ok        | 0    | 25 frames, 1 commit, root matches reference        |
| abort     | 0    | session 1 aborted (`nozzle_jam`), session 2 commits |
| conflict  | 6    | same-session DATA after END rejected, old cert kept |
| truncated | 2    | 58 unconsumed bytes, committed cert intact         |
| badcrc    | 0    | 1 `bad_crc` logged, stream completes               |
