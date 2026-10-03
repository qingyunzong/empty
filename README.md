# trace — auditable bolt-tightening certification

Node.js 22, standard library only. Joins tightening-gun curves (`torque`),
station calibration (`calib`) and barcode lots (`scan`) into versioned,
auditable release certificates for every bolt.

## Usage

```sh
node bin/trace.js certify --in <dir> --out <dir> \
  [--window-ms 500] [--watermark-lag-ms 1000] [--angle-min 0] [--angle-max 720]
```

Reads every `*.jsonl` file in `--in` (sorted by name, line order = arrival
order) and writes:

- `certs.jsonl` — append-only stream of certificate versions (`OK` / `HOLD`)
- `void.jsonl` — append-only stream of `VOID` certificate versions
- `late.log` — events whose `eventTs` fell below the watermark on arrival

## Input events (one JSON object per line)

```json
{"type":"torque","id":"t1","eventTs":10000,"bolt":"B1","tool":"T1","peak":12.5,"angle":90,"op":"alice"}
{"type":"calib","id":"c1","eventTs":1000,"tool":"T1","ok":true,"validFrom":0,"validTo":20000,"op":"qa"}
{"type":"scan","id":"s1","eventTs":10300,"bolt":"B1","lot":"L1","op":"alice"}
{"type":"retract","eventTs":15000,"kind":"calib","id":"c1"}
```

## Semantics

- **Winning tightening**: per bolt, only non-retracted `torque` events with
  `angleMin <= angle <= angleMax` qualify; the last one wins, ties broken by
  `(eventTs, id)`. Out-of-range angles are reported as `ANGLE_RANGE` on stderr
  and never qualify.
- **Calibration join**: a `calib` applies to the winning tightening when its
  `[validFrom, validTo]` interval overlaps the join window
  `eventTs ± --window-ms` and `ok` is true; the latest `(eventTs, id)` wins.
- **Lot join**: a `scan` applies when it is for the same bolt and within
  `eventTs ± --window-ms` of the winning tightening.
- **Status**: `OK` when calibration and lot are both present; `HOLD` when the
  lot (`MISSING_LOT`) or calibration (`NO_CALIB`) is simply absent — never an
  error; `VOID` when a previously applicable calibration was retracted
  (`CALIB_RETRACTED`) or the winning tightening was retracted
  (`TORQUE_RETRACTED`).
- **Retraction cascades**: retracting a calibration re-judges every bolt
  tightened with that tool; certificates transition `OK -> VOID` (or recover to
  a new `OK` version when another calibration covers the window). Old versions
  are never deleted — every change appends a new versioned record.
- **Watermark / lateness**: `watermark = max(eventTs) - --watermark-lag-ms`.
  Late events are logged to `late.log` but still applied, so a late `scan`
  turns a `HOLD` into `OK`.
- **Duplicates**: re-sending an identical event id is idempotent; a
  conflicting event with the same id aborts with `DUP_EVENT` (exit code 1).

## Library

```js
import { Certifier } from './src/certify.js';
const c = new Certifier({ windowMs: 500 });
c.ingest(event);           // -> { duplicate, late }
c.finalCerts();            // Map<bolt, latest cert version>
c.emissions; c.late; c.reports;
```

## Tests

```sh
node --test
```
