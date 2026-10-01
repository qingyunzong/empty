# leasesim

Deterministic multi-resource lease simulator. Python 3.11+, standard library
only. Tests use `unittest`.

## Usage

```
python -m leasesim run ops.json --out state.json
```

Without `--out`, the state JSON is printed to stdout.

### Input format

```json
{
  "resources": {"r1": 1, "r2": 2},
  "ops": [
    {"t": 0, "client": "A", "acquire": {"r1": 1}, "ttl": 3},
    {"t": 1, "client": "B", "release": ["r2"]}
  ]
}
```

* `resources`: resource name -> capacity (positive integer).
* Each op: `t` (tick, non-negative int), `client` (string), plus `acquire`
  (object resource -> need) and/or `release` (list of resources). `ttl`
  (non-negative int) is optional and only valid with `acquire`.

### Semantics

* Ops are processed in ascending `t`; ties break by client name
  (lexicographic), then input order.
* `acquire` is atomic: either the whole request is granted at once, or it
  holds nothing and waits.
* A lease acquired at tick `t` with `ttl` expires at `t + ttl`. Expirations
  due at tick `t` are processed before the new ops of tick `t`. `ttl = 0`
  means the lease is released at the end of the current tick. A missing
  `ttl` means the lease never expires.
* Waiting requests are queued by `(request t, client)`. Whenever the queue
  is drained (after a release/expiry), requests are scanned in that order:
  a request that can be fully satisfied is granted; a request whose wait
  would close a cycle in the wait-for graph (edge `X -> Y` = X waits for a
  resource held by Y) is rejected with `DEADLOCK`; the rest stay queued.
  The queue never blocks the whole system behind one unsatisfiable request.
* `release` frees only amounts actually held; releasing a resource the
  client does not hold is an error.

### Output

JSON object with `events` (ordered log with per-op results `GRANTED` /
`WAITING` / `DEADLOCK` / `RELEASED` / `EXPIRED`), final `holders`, still
`waiting` requests, and `resources`. Output is canonical (sorted keys,
fixed indentation), so repeated runs are byte-identical.

### Exit codes

* `0` — success.
* `2` — error: `need <= 0`, `need > capacity`, a client acquiring a
  resource it already holds (duplicate concurrent holding conflict),
  releasing an unheld resource, unknown resource, malformed/unreadable
  input.

## Tests

```
python -m unittest discover -s tests -v
```

Last run (this checkout): **16 tests, OK** (~3 s). Coverage includes:

* A: two resources / two clients crossed requests — second request is
  `DEADLOCK`, the system keeps processing afterwards.
* B: lease expiry is ordered before same-tick acquires; `ttl = 0` releases
  at end of tick.
* C: atomicity — a three-resource request missing one resource holds
  nothing.
* D: fuzz (1500 seeds, <= 6 ops, <= 3 resources) cross-checks every event
  and all DEADLOCK marks against an independent reference model that
  detects wait-for cycles with Kahn's topological algorithm (the simulator
  itself uses iterative DFS reachability).
* E: repeated CLI runs produce byte-identical output.

## Recorded example runs

### Deadlock example

```
$ python -m leasesim run examples/deadlock.json --out state.json
$ echo $?
0
```

Event results: `GRANTED(A:r1) GRANTED(B:r2) WAITING(A:r2) DEADLOCK(B:r1)
RELEASED(B:r2) GRANTED(A:r2)` — at `t=3` client B's request would close the
wait-for cycle `A -> B -> A`, so it is rejected as `DEADLOCK`; when B
releases `r2` at `t=4`, A's queued request is granted.

Final `holders`: `{"A": {"r1": 1, "r2": 1}}`, `waiting`: `[]`.

sha256 of the emitted `state.json`:

```
0db82f9317747aaa8a59f78af12dc00d35903660299ace5e6f881e9c9d6dd526
```

### Normal example (expiry ordering + ttl=0)

```
$ python -m leasesim run examples/normal.json --out state.json
$ echo $?
0
```

Event results: `GRANTED(A:r1,r2) GRANTED(B:r1) WAITING(C:r2) EXPIRED(A)
GRANTED(C:r2) GRANTED(D:r1) EXPIRED(D) RELEASED(B:r1)` — A's lease
(`ttl=2`) expires at `t=2` before D's same-tick acquire; C's queued
request is granted from the expiry; D's `ttl=0` lease is released at the
end of tick 2.

Final `holders`: `{"C": {"r2": 1}}`, `waiting`: `[]`.

sha256 of the emitted `state.json`:

```
159f2b1951ad983ee61c8aede75c6977c9c02f0554ecfb8d4aee057f0b9af7d9
```

### Error example

```
$ echo '{"resources":{"r1":1},"ops":[{"t":0,"client":"A","acquire":{"r1":5}}]}' > bad.json
$ python -m leasesim run bad.json
error: op #0: need 5 exceeds capacity of 'r1'
$ echo $?
2
```

## Layout

* `leasesim/simulator.py` — simulation core (atomic acquire, expiry heap,
  wait queue, wait-for cycle detection).
* `leasesim/cli.py`, `leasesim/__main__.py` — CLI entry point.
* `tests/test_simulator.py` — acceptance A/B/C, ordering, error cases.
* `tests/test_fuzz.py` — acceptance D (independent Kahn-based reference).
* `tests/test_cli.py` — CLI exit codes and byte-identical determinism (E).
* `examples/` — the ops files used above.
