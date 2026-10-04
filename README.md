# agv-chain-recorder

Offline AGV job-chain event recorder. Node.js 22, standard library only.

Rebuilds directed job chains from a stream of `ASSIGN` / `PICK` / `DROP` /
`FAIL` / `RETRY` events that may arrive duplicated, out of order, fragmented
across frames, or after timeouts.

## Event format

One JSON object per frame (JSONL or concatenated fragments):

```json
{"type":"PICK","job":"jobA","leg":"L1","seq":1,"causes":["jobB"],"ts":1700000000000}
```

- Same-job events are ordered by `seq` (ties: `ts`, then content hash).
- Cross-job edges come from `causes` (job ids this event depends on).
- `RETRY` is legal only immediately after the job's latest `FAIL` and must
  open a brand-new leg; old legs are immutable.
- A `FAIL` is compensated when its `RETRY` leg reaches `DROP` before any
  further `FAIL`. Root-cause analysis reports the earliest uncompensated
  `FAIL` set (failures not explained by an upstream uncompensated failure).
- A virtual clock (max observed `ts`) marks `PICK`s without `DROP` as `stale`
  after `--timeout-ms`. A later `DROP` revokes the mark; the stale log keeps
  both the mark and the revocation.

## Usage

```sh
node cli.js ev.jsonl --cert c.json [--timeout-ms 30000]
```

Exit codes: `0` ok, `2` bad input/usage, `14` causes cycle (batch rejected),
`15` illegal `RETRY` (batch rejected).

The certificate (`c.json`) contains the chain hash, per-leg status, the
append-only stale log with revocations, uncompensated fails and root causes.

## Tests

```sh
node --test
```
