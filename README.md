# flight-tracker

Flight plan / ground observation matching engine. Node.js 22, standard
library only, tested with `node:test`.

## Usage

```sh
node src/cli.js tracks --in events.jsonl            # actions to stdout
node src/cli.js tracks --in events.jsonl --out actions.jsonl
node --test                                          # run the test suite
```

Library API:

```js
import { Tracker } from "./src/index.js";
const tracker = new Tracker();
const actions = tracker.processEvent(event); // actions emitted by this event
```

## Input events (JSONL, one object per line)

- `{"type":"FLIGHT_PLAN","flightId":"alpha","start":0,"end":100,"polygon":[[x,y],...],"version":1}`
  A new plan, or a correction when `flightId` already exists and `version`
  is strictly higher. Corrections may replace the polygon (and window).
- `{"type":"GROUND_OBSERVATION","obsId":"o1","ts":10,"x":5,"y":5}`
- `{"type":"RETRACT","flightId":"alpha"}` — withdraw a plan.
- `{"type":"WATERMARK","ts":15}` — advance the public watermark.

## Matching semantics

- An observation matches a plan when `start <= ts < end` and the point is
  inside the polygon under the **even-odd rule**; points exactly on an edge
  or vertex count as inside (`classification: "EDGE"`).
- Reference algorithm: every observation brute-force scans all plans with a
  point-in-polygon test per plan.
- When several plans match, the lexicographically smallest `flightId` wins.
- A higher `version` overrides a lower one for the same `flightId`; a lower
  or equal version is rejected with `STALE_VERSION`.

## Buffering and publication

- Observations may arrive out of order. A matching observation emits `MATCH`
  (with a certificate) immediately; an unmatched one is buffered.
- A buffered observation is **published** once the public watermark reaches
  `ts + 5` seconds; still-unmatched observations then emit `UNMATCHED`.
- Before publication, plan corrections recompute every buffered observation
  in the affected window, and retractions cascade `WITHDRAW` actions to all
  observations matched to the removed plan (re-matching them if another
  plan still covers them).
- Any plan modification or retraction touching an already published
  observation is rejected with `LATE`.

## Output actions (JSONL)

- `{"action":"MATCH","obsId","flightId","certificate":{...}}` — the
  certificate records the plan version, point, classification
  (`INSIDE`/`EDGE`), rule (`even-odd`), window and polygon.
- `{"action":"UNMATCHED","obsId"}`
- `{"action":"WITHDRAW","obsId","flightId","reason"}` — reason is
  `PLAN_ADDED`, `PLAN_CORRECTED` or `PLAN_RETRACTED`.
- `{"action":"ERROR","error":<code>,...}` with codes `INVALID_POLYGON`
  (fewer than 3 vertices), `MALFORMED` (non-numeric coordinates or bad
  shape), `UNKNOWN_RETRACT`, `STALE_VERSION`, `LATE`.

## Layout

- `src/geometry.js` — even-odd point-in-polygon with on-edge detection.
- `src/tracker.js` — event processing, buffering, watermark publication.
- `src/cli.js` — `tracks` command (also importable as `run(args, io)`).
- `test/` — `node:test` suites; `examples/events.jsonl` — sample stream.
