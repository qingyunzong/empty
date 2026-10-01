# netsim

Deterministic single-process discrete-event network simulator (Python 3.11+,
standard library only). No real network I/O. Up to 8 nodes.

## Usage

```
python -m netsim run topo.json --faults faults.json --steps 1000 --seed 3
python -m netsim run topo.json --faults faults.json --check   # determinism check
```

Output is JSONL: one JSON object per observed event (`send`, `recv`, `drop`,
`dup`, `dup_ignored`, `buffered`, `timeout`, `clock_apply`), followed by a
final `{"type": "summary", ...}` line. Invalid configuration prints an error
to stderr and exits with code 2.

## Semantics

- **Event heap**: keyed by `(time, seq, src, dst)`; events at the same global
  time are ordered by a monotonically increasing `seq`, so a fixed seed
  reproduces runs bit-for-bit.
- **Fault phases**: rules apply to each sent message in the fixed order
  `drop -> dup -> delay -> clock_apply`, independent of the key order in the
  faults JSON document.
- **Partitions**: a partition `{a, b, start, end}` blocks both directions of
  that edge only; matching messages sent during `[start, end)` are buffered
  and delivered at `end + latency` after recovery.
- **Clocks**: `local_time = global_time + offset`. Offsets (initial via
  `clock_offsets`, changed via `clock_apply` faults) shift local timestamps
  and local timeout scheduling only; they never change global event times or
  the global event order.
- **Dedup**: receivers deduplicate by application `app_id`; extra copies are
  logged as `dup_ignored`.
- **DIVERGE**: `--check` runs the simulation twice and compares per-node log
  prefixes; on mismatch it prints `DIVERGE` plus the last log lines of the
  two nodes involved and exits 1.

## Config formats

`topo.json`:

```json
{
  "nodes": [{"id": "n1", "timeout_interval": 50}, "n2"],
  "links": [{"src": "n1", "dst": "n2", "latency": 3, "jitter": 2}],
  "clock_offsets": {"n2": 8},
  "workload": [{"time": 0, "src": "n1", "dst": "n2", "app_id": "m1", "payload": "ping"}]
}
```

`faults.json` (all sections optional; `src`/`dst` accept `"*"`):

```json
{
  "drop": [{"src": "n1", "dst": "n2", "rate": 0.2}],
  "dup": [{"src": "n2", "dst": "n1", "rate": 0.5, "copies": 1}],
  "delay": [{"src": "*", "dst": "n3", "extra": 3}],
  "clock_apply": [{"node": "n3", "offset": 20, "at": 10}],
  "partitions": [{"a": "n1", "b": "n2", "start": 10, "end": 18}]
}
```

See `examples/` for runnable inputs.

## Tests

```
python -m unittest discover -s tests -v
```
