# sessionize

Event-time sessionization library + CLI (Python 3.11 standard library only).

## Usage

```
python -m sessionize --in e.jsonl --gap 30000 --late 5000 [--out out.jsonl]
```

Input: JSONL, one `{"key", "ts", "id"}` object per line. Output: JSONL
records on stdout (or `--out`). A line missing `id` (or `key`/`ts`), invalid
JSON, or a non-numeric `ts` exits with code 2.

## Semantics

* Per `key`, events are ordered by event time `ts`; adjacent events with
  distance `<= gap` share a session, `>= gap + 1` splits. Multiple events of
  one key at the same `ts` are counted individually.
* Per-key watermark `WM = max_ts - late`. A session is emitted as `FINAL`
  only when `end + gap <= WM`.
* A late event (`ts < WM`) is *legal* when it still merges with at least one
  existing session of its key. It is inserted and may merge several old
  sessions; if any merged session was already `FINAL`, the output is a
  `RETRACT` record listing the old sessions followed by an `ADD` record with
  the new merged session. A late event that merges nothing exceeds the
  allowed lateness and is dropped (`DROP` record).
* Note: a single event can bridge at most two existing sessions, because
  neighbouring sessions are separated by more than `gap` (a point can be
  within `gap` of at most two of them). The retraction test therefore uses
  three finalized sessions and shows one late event bridging two of them
  while the third stays untouched.
* Session representation: `{"key", "start", "end", "count", "ids"}` where
  `ids` is the sha256 hex digest of the sorted event ids concatenated
  together.

## Library

```python
from sessionize import Sessionizer
sz = Sessionizer(gap=30000, late=5000)
records = sz.add("k", 0, "a")   # list of FINAL/RETRACT/ADD/DROP dicts
sz.sessions("k")                # current sessions
sz.finals("k")                  # sessions currently emitted as FINAL
```

## Tests

```
python -m unittest discover -v
```
