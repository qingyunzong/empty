# trace-certify

Auditable bolt-tightening certification for battery-pack assembly. Joins
tightening-gun curves (torque), station calibration and barcode lots into
versioned, append-only release certificates. Node.js 22, standard library
only, offline, single machine.

## Usage

```sh
node bin/trace.js certify --in <dir> --out <dir> [--window 500] [--lateness 0] [--angle-min 0] [--angle-max 360]
```

Reads every `*.jsonl` file in `--in` (sorted by file name, then line order)
and writes into `--out`:

| file          | content                                             |
| ------------- | --------------------------------------------------- |
| `certs.jsonl` | every certificate version, append-only audit log    |
| `void.jsonl`  | one record per OK -> VOID transition                |
| `late.log`    | events that arrived behind the watermark            |
| `errors.jsonl`| DUP_EVENT / ANGLE_RANGE / INVALID_EVENT / ...       |

## Input events (one JSON object per line)

```json
{"id":"t1","type":"torque","eventTs":1000,"bolt":"B1","tool":"T1","peak":12.5,"angle":45,"op":"OP1"}
{"id":"c1","type":"calib","eventTs":100,"tool":"T1","ok":true,"validFrom":0,"validTo":5000,"op":"QA"}
{"id":"s1","type":"scan","eventTs":1200,"bolt":"B1","lot":"L1","op":"OP1"}
{"type":"retract","eventTs":6000,"kind":"calib","id":"c1"}
```

`retract.id` is the *target* event id; `kind` is `torque` | `calib` | `scan`.

## Semantics

- **Effective tightening**: per bolt, the last (by `eventTs`, ties by `id`,
  numeric-aware) torque event that is not retracted and whose `angle` is
  inside `[--angle-min, --angle-max]` (default `[0, 360]`). An illegal angle
  is reported as `ANGLE_RANGE` and the event is disqualified.
- **Calibration join**: a non-retracted `calib` with `ok: true` whose
  `[validFrom, validTo]` interval covers the tightening `eventTs`.
- **Lot join**: a non-retracted `scan` for the same bolt within
  `±--window` ms (default 500) of the tightening `eventTs`.
- **Statuses**: `OK` (calib + lot), `HOLD` (missing calib -> `NO_CALIB`,
  missing lot -> `NO_LOT`; never an error), `VOID` (a previously `OK`
  certificate lost its basis, e.g. calib retraction; sticky until a later
  re-judgement can certify `OK` again).
- **Retraction cascades**: retracting a calibration re-judges every affected
  bolt; historical certificates are never deleted — a new `VOID` version is
  appended and recorded in `void.jsonl`. A later valid calibration recovers
  the bolt with a new `OK` version.
- **Watermark**: `watermark = max(eventTs seen) - --lateness`. Events with
  `eventTs < watermark` are logged to `late.log` but still applied (a late
  scan flips `HOLD` -> `OK`).
- **Duplicate ids**: an identical replay is an idempotent no-op; a
  conflicting payload for the same id is reported as `DUP_EVENT` and the
  first occurrence is kept.

## Library

```js
import { Engine, certifyEvents, certifyDir } from './index.js';

const result = certifyEvents(rawEvents, { windowMs: 500, latenessMs: 0 });
// { certs, voids, late, errors, final }
```

## Tests

```sh
node --test
```

See `RESULTS.md` for the recorded run.
