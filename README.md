# leasesim

Deterministic lease simulator: atomic multi-resource acquisition, TTL
expiry and wait-for-graph deadlock avoidance.  Python 3.11+ standard
library only.

## Usage

```
python -m leasesim run ops.json --out state.json
```

Exit codes: `0` success, `2` invalid input or semantic conflict
(message on stderr, no output file written).

## Input format (`ops.json`)

```json
{
  "resources": {"r1": 1, "r2": 1},
  "ops": [
    {"t": 0, "client": "a", "acquire": {"r1": 1}, "ttl": 10},
    {"t": 2, "client": "a", "release": ["r1"]}
  ]
}
```

* `resources`: resource name -> capacity (positive integer).
* Each op has `t` (non-negative int), `client` (non-empty string) and
  exactly one of `acquire` (object resource -> need, plus non-negative
  `ttl`) or `release` (list of resource names).
* Ops are processed in `(t, client)` order; duplicate `(t, client)` is
  an error.

## Semantics

1. **Atomic acquire** — a request gets its whole bundle or waits
   holding nothing.
2. **TTL expiry** — a lease granted at `t` with `ttl = k` expires at
   `t + k`; expiries at time `s` are processed before ops with `t = s`.
   `ttl = 0` releases the lease at the end of the granting tick.
3. **Waiting queue** — waiters queue by `(request_t, client)` and are
   granted strictly from the head (FIFO, head-of-line blocking).  After
   every state change a wait-for graph (waiter -> holders of resources
   it cannot fully get) is checked for cycles; the request with the
   largest `(t, client)` on a cycle is marked `DEADLOCK` and dropped,
   so the system never blocks forever, and processing continues with
   the rest of the queue.
4. **Release** — releases only what the client actually holds;
   releasing an unheld resource is an error.
5. **Output** — every op produces a result entry
   (`GRANTED` / `WAITING` / `DEADLOCK` / `RELEASED`); lease expiries
   produce `EXPIRED` entries and later grants of queued requests
   produce `grant` entries.  `holders` is the final holder map.

Errors (exit code 2): `need <= 0`, `need > capacity`, unknown resource,
duplicate `(t, client)` op, a client acquiring a resource it already
holds or acquiring while another request is pending (concurrent-hold
conflict), releasing an unheld resource, malformed input.

## Output format (`state.json`)

Deterministic (`json.dumps(..., indent=2, sort_keys=True)`), so repeated
runs are byte-identical:

```json
{
  "holders": {"a": {"expires_at": {"r1": 10}, "resources": {"r1": 1}}},
  "resources": {"r1": 1},
  "results": [
    {"client": "a", "kind": "acquire", "result": "GRANTED", "seq": 0, "t": 0, ...}
  ]
}
```

## Tests

```
python -m unittest discover -s tests -v
```

Last run: **23 tests, OK** (acceptance A-E, error paths, CLI
subprocess, and a 400-seed randomized cross-check of the deadlock
marking against an independent reference implementation in
`tests/test_fuzz.py`; an additional offline 5000-seed run matched on
all 1109 valid scenarios, exercising 312 deadlocks).

## Recorded real runs

Deadlock example (`examples/deadlock.json`, two clients crossing
requests on `r1`/`r2`; the second crossed request is `DEADLOCK`, the
system continues and `a` is granted `r2` after `b` releases):

```
$ python -m leasesim run examples/deadlock.json --out state.json
wrote state.json (DEADLOCK=1, GRANTED=3, RELEASED=1, WAITING=1); sha256=bf8ed5ce2b842b289044edf529cb30eee166f283ac202a50794d1736608a3ce2
$ echo $?
0
```

Final state hash: `sha256(state.json) = bf8ed5ce2b842b289044edf529cb30eee166f283ac202a50794d1736608a3ce2`,
final holders: `{"a": {"resources": {"r1": 1, "r2": 1}, "expires_at": {"r1": 10, "r2": 12}}}`.
Re-running produces a byte-identical file (verified with `cmp`).

Normal example (`examples/normal.json`, TTL expiry drives queued
grants):

```
$ python -m leasesim run examples/normal.json --out state.json
wrote state.json (EXPIRED=3, GRANTED=5, RELEASED=1, WAITING=2); sha256=b88d6d70de57b727a9fd3b0af907f77d737ada746ff5291d9c9b45453ff86cdb
$ echo $?
0
```

Final state hash: `sha256(state.json) = b88d6d70de57b727a9fd3b0af907f77d737ada746ff5291d9c9b45453ff86cdb`,
final holders: `{"echo": {"resources": {"cpu": 1}, "expires_at": {"cpu": 7}}}`.

Error example (`examples/over_capacity.json`):

```
$ python -m leasesim run examples/over_capacity.json --out state.json
leasesim: error: op #0: need 2 exceeds capacity of 'r1' (1)
$ echo $?
2
```

## Layout

* `leasesim/sim.py` — simulator core (queue, wait-for graph, expiry)
* `leasesim/cli.py` — argument parsing, input validation, output
* `tests/test_sim.py` — acceptance A/B/C/E, error and CLI tests
* `tests/test_fuzz.py` — acceptance D: independent reference
  implementation (BFS self-reachability cycle detection) + randomized
  cross-check with <= 6 ops and <= 3 resources
* `examples/` — sample inputs
