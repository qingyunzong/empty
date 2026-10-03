# agv-scheduler

Offline replay of one day of warehouse AGV events to judge whether task
assignments are safe. Node.js 22, standard library only, `node:test`, single
process, no network.

## Model

- **Membership**: AGVs `join` / `leave` / `quarantine`.
  - `leave`: the AGV may not claim; its unfinished granted tasks enter the
    **takeover set**. Its leases stay valid until they expire.
  - `quarantine`: the AGV may not claim *new* tasks; its history and existing
    leases are preserved (and still block others until expiry).
- **Claims** carry a fencing **epoch** and a **vector clock**. Per task the
  engine keeps the causal frontier of accepted claims:
  - `epoch < max epoch seen` → `stale` (fencing violation, CLI exit 8).
  - Claim **concurrent** (incomparable) with a frontier claim → the task goes
    to `pending` (never an error). A lease granted without causal knowledge
    of this competitor is revoked as unsafe.
  - Claim causally dominated → `superseded` (inert).
  - Claim **dominating** the whole frontier → `granted`, unless a live lease
    of another holder blocks it (`blocked-lease`). A takeover requires
    `ts >= previous lease expiry`.
- Only a claim that causally dominates every competing claim ever seen for
  the task produces a safe grant, so the final state of concurrent claims is
  independent of arrival order.

## Persistence & crash recovery

State directory layout:

```
state/
  events.jsonl        # append-only journal {seq, tseq?, ev, lease?}
  leases/<task>.json  # committed lease (tmp+rename), sha256-checksummed
  leases/<task>.json.tmp
```

Lease commits write `lease.tmp`, fsync, then atomically `rename`. Crash
injection points and their defined restart results:

| crash point      | on disk after crash                | recovery result                                  |
|------------------|------------------------------------|--------------------------------------------------|
| `after-tmp-write`| orphan `*.tmp`, old lease intact   | tmp discarded; old state authoritative           |
| `before-rename`  | orphan `*.tmp`, old lease intact   | tmp discarded; old state authoritative           |
| `after-rename`   | new lease renamed, journal missing | lease is authoritative; adopted into the journal |

At most one lease record is authoritative per task, so recovery never leaves
double ownership. Validation failures (corrupt journal, checksum mismatch,
fencing epoch regression, schema violations) raise exit code 9.

## CLI

```
agv replay  --in events.jsonl [--state dir] [--out file] [--crash-point P]
agv lease claim --state dir --task T --agv A --epoch N [--ttl ms] [--now ts] [--clock JSON] [--crash-point P]
agv lease show   --state dir --task T
agv recover --state dir
agv audit   --state dir
```

Input and output are JSONL. `replay` emits one decision line per event plus a
final `summary` line. Exit codes:

| code | meaning                                  |
|------|------------------------------------------|
| 0    | ok                                       |
| 1    | audit found invariant violations         |
| 2    | usage error                              |
| 8    | low-epoch (stale) claim                  |
| 9    | persistence validation failure           |
| 70   | simulated crash at an injection point    |

## Event schema (replay input)

```json
{"type":"join","agv":"A","ts":0}
{"type":"leave","agv":"A","ts":10}
{"type":"quarantine","agv":"A","ts":10}
{"type":"claim","task":"T1","agv":"A","epoch":1,"ttl":100,"ts":5,"clock":{"A":1}}
{"type":"complete","task":"T1","agv":"A","epoch":1,"ts":50}
{"type":"tick","ts":200}
```

Decisions: `joined` `left` `quarantined` `granted` `pending` `blocked-lease`
`stale` `superseded` `duplicate` `completed` `stale-complete`
`rejected(reason)` `tick`.

## Tests

`node --test` runs the full suite:

- `test/concurrency.test.js` — acceptance 1: three concurrent claims, all 3!
  orders → identical deterministic `pending` final state; a dominating
  resolver claim wins deterministically.
- `test/crash.test.js` — acceptance 2: crash at all three injection points,
  including mid-takeover, recovers with exactly one owner.
- `test/takeover.test.js` — acceptance 3: after `leave`/`quarantine` the old
  lease must expire before takeover; quarantine keeps history.
- `test/enumerate.test.js` — acceptance 4: all n! orders for n=1..6 tasks and
  all linear extensions of a causal poset produce identical final states.
- `test/persistence.test.js` — validation failures (exit 9 paths).
- `test/cli.test.js` — JSONL in/out and exit codes 0/1/2/8/9/70.
- `test/engine.test.js`, `test/clock.test.js` — unit coverage.
