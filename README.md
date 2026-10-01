# netsim

Deterministic single-process event-loop network simulator (Python 3.11
standard library only). No real networking: up to 8 nodes exchange messages
with point-to-point delay, loss, duplication, reordering (via jitter), and
per-node clock offsets.

## Usage

```
python -m netsim run topo.json --faults faults.json --steps 1000 --seed 3 \
    [--output out.jsonl] [--assert-consistency]
```

Output is JSONL: one JSON object per event, terminated by a `summary`
object containing counters, per-node logs, and a SHA-256 `digest` of the
event stream. Exit codes: `0` ok, `1` log divergence detected (only with
`--assert-consistency`), `2` invalid configuration.

## Semantics

1. **Event key** — the event heap is keyed by `(time, seq, src, dst)`;
   `seq` is a global monotone counter, so same-time events pop in stable
   scheduling order.
2. **Fixed fault phases** — each send runs the pipeline
   `drop -> dup -> delay -> clock_apply`. Rules are canonicalised
   (sorted by JSON serialization) within each phase, so the result never
   depends on the order rules are listed. A dropped message never reaches
   later phases; duplicated copies share the computed delay; `clock_apply`
   only stamps local timestamps.
3. **Partitions** — a partition blocks an edge only when *both* directions
   appear in its `edges` list. Blocked messages are buffered and released
   FIFO when the partition ends (overlapping partitions keep the buffer).
4. **Clock offsets** — a node's local time is `global + offset`. Offsets
   shift local timeouts (a timeout at local `T` fires at global `T - offset`)
   and local timestamps, but never the global event order.
5. **Consistency assertion** — with `--assert-consistency`, every step
   checks that all node logs are pairwise prefix-compatible. On failure a
   `diverge` record is emitted with the two node ids and their last log
   entries, `DIVERGE <a> <b>` goes to stderr, and the exit code is 1.

Duplicates are removed by the receiver using the application id
(`app_id`): repeated deliveries of the same `app_id` are logged as
`duplicate` events and never touch the node log.

## Configuration

`topo.json`:

```json
{
  "nodes": [{"id": "n1", "clock_offset": 0,
             "timeouts": [{"id": "t1", "at_local": 100}]}],
  "links": [{"src": "n1", "dst": "n2", "delay": 5, "jitter": 3}],
  "workload": [{"time": 0, "src": "n1", "dst": "n2",
                "app_id": "m1", "payload": "..."}]
}
```

`faults.json` — `{"rules": [...]}` with rule types:

- `drop` / `dup`: `prob` in `[0,1]`, optional `src`, `dst`, `start`, `end`
- `delay`: `extra >= 0`, optional matchers as above
- `partition`: `edges: [[a, b], [b, a], ...]`, `start`, `end`
- `clock`: `node`, `offset`, `start` (rewrites the node offset at `start`)

## Tests

```
python -m unittest discover -s tests -v
```
