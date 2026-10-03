# Biobank Freezer Allocator

Deterministic allocation of incoming sample tubes to -80℃ freezer racks.
Node.js 22, standard library only, tests via `node:test`.

## Layout

- `src/biobank.js` — core library: event validation, hard-constraint bin
  packing, quotas + fairness, preemption, undo/replay, certificate hash.
- `src/journal.js` — append-only journal with per-record CRC; torn tail
  detection and truncation for crash recovery.
- `src/bruteforce.js` — exact optimum enumerator (n <= 12) used as test
  ground truth.
- `bin/biobank.js` — CLI: JSONL events in, JSONL step results out.
- `test/*.test.js` — acceptance tests.

## Usage

```
node bin/biobank.js [events.jsonl] [--journal journal.log]
```

With no file argument, events are read from stdin. The first line must be a
config event:

```json
{"type":"config","racks":[{"id":"R1","zone":"-80","capacity":2}],"quotas":{"P1":1},"aging":1,"freezeAfter":5}
```

- `racks`: `id`, `zone`, `capacity` (positive integer).
- `quotas`: max simultaneously placed samples per project (absent = unlimited).
- `aging`: priority weight in the fairness key (default 1).
- `freezeAfter`: time units after placement during which a sample is still
  preemptible (default 10); afterwards it is frozen.

### Events (one JSON object per line)

- `{"type":"arrive","id":"S1","project":"P1","priority":5,"zone":"-80","arrival":0,"deadline":100}`
- `{"type":"correct","id":"S1","time":3,"priority":9,"deadline":40}` — change
  priority and/or deadline of a live sample.
- `{"type":"cancel","id":"S1","time":4}` — remove a waiting sample.
- `{"type":"undo","to":2,"time":5}` — hierarchical rollback to the state after
  the first 2 effective events; replay is deterministic, so the certificate
  hash after undo equals the hash recorded at that earlier point.

Event times must be non-decreasing (`arrival` is the time of an `arrive`).

### Per-step output (stdout, JSONL)

```json
{"step":3,"event":{...},"type":"arrive",
 "placements":[{"id":"C","rack":"R1","slot":0}],
 "preemptions":[{"by":"C","withdrawn":"A"}],
 "expired":[],
 "waiting":[{"id":"A","reason":"quota_exceeded"}],
 "hash":"5cb594a2..."}
```

`hash` is a deterministic SHA-256 certificate over the canonical snapshot
(clock, effective event count, all samples, all rack slots). Replaying the
same event prefix always reproduces the same hash.

## Allocation rules

Hard constraints (never violated): zone match, rack capacity, per-project
quota, and same-project adjacency (a sample placed into a rack that already
holds its project must occupy a slot adjacent to a same-project slot).

Each event triggers a placement pass over the waiting queue, ordered by the
fairness key `(arrival - priority*aging, arrival, id)` — longest effective
wait first, priority gives only a bounded boost (`aging` time units per
priority level), so high-priority arrivals cannot jump the queue indefinitely.
Ties break by ascending sample id.

Preemption: a waiting sample that cannot be placed may withdraw a placed
sample that is (a) not frozen, (b) strictly lower priority, and (c) never
preempted before (one-shot shield). The withdrawal is recorded in the step's
`preemptions` log and is fully reversible via `undo`. Waiting samples whose
deadline has passed expire (`expired`).

Rejection reasons reported per waiting sample: `no_zone`, `quota_exceeded`,
`no_capacity`, `adjacency`.

## Errors

Illegal events, capacity overflow (invalid rack capacity/quota) and time
regression print one JSON object to stderr and exit with code 2; the state is
left unchanged (all validation happens before any mutation):

```json
{"error":"time_regression","detail":"event time 3 is before current clock 5","line":3}
```

## Crash recovery

With `--journal PATH`, every applied record (`config`/`event` + resulting
hash + CRC) is appended to the journal. On startup the journal is validated
record by record; a half-written or corrupted tail record is rejected, the
file is truncated to the last valid record, a `torn_journal_record` warning
is emitted on stderr, and processing resumes from the recovered state.

## Tests

```
node --test test/*.test.js
```

Coverage: (1) 20 mixed arrivals, placed count compared against brute-force
optimum for every prefix n <= 12; (2) quota exhaustion: low-priority waits,
high-priority cannot jump the queue forever (frozen + one-shot shield);
(3) preemption followed by `undo` restores the withdrawn sample and replays
to identical hashes; (4) crash mid-journal-write: the torn record is rejected
after restart; plus illegal-event / capacity-overflow / time-regression
errors (stderr JSON, exit 2, state unchanged).

Real output of the last run (exit code 0):

```
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 13999.062399
```
