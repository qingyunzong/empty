# safety-interlock-monitor

Offline, single-machine safety-interlock monitor. Node.js 22, standard
library only (`node:test` for tests). No dependencies, no network.

The monitor consumes sensor events, checks them against a regular-expression
safety property describing a **forbidden sequence**, and survives process
crashes with a deterministic, three-valued monitor state:

| state       | meaning                                                        |
|-------------|----------------------------------------------------------------|
| `VIOLATION` | a forbidden sequence is confirmed; **irreversible**            |
| `SAFE`      | no event ordering and no future extension can ever violate     |
| `UNKNOWN`   | outcome still open, pending more events / backfill             |

`UNKNOWN` is never reported as `SAFE` and the tool never emits any
"UNSAT certificate": absence of a confirmed violation is not a proof of
safety.

## Run

```sh
node --test                  # 3 test files, 24 subtests
node cli.js mon.jsonl        # process an input script
```

CLI options: `--wal PATH`, `--chk PATH` (default: `<input>.wal` /
`<input>.chk`), `--pattern REGEX` (alternative to an `init` record).

## Semantics

**Regex property.** The pattern is anchored at the start of the monitored
stream and describes the forbidden sequence. Syntax: literals (`arm`),
wildcard (`.`), concatenation (whitespace), alternation (`|`), `*` `+` `?`,
groups `()`, `\` escapes. The pattern compiles to a DFA whose accepting
states are sinks — a confirmed violation can never be revoked, not even by
later backfilled events.

**Three-valued verdict.** The monitor tracks the *set* of DFA states the
stream could be in. `VIOLATION` if any reachable state is accepting
(conservative alarm), `SAFE` if every reachable state is dead (no path to
acceptance remains), otherwise `UNKNOWN`.

**Macro-steps.** Events in one `batch` are simultaneous. They are ordered by
a fixed tie-break (numeric ids ascending, then string ids in code-unit
order) for the WAL record, and the monitor computes the set of DFA states
reachable under *every* intra-batch permutation (exact DP over count
vectors; cross-checked against brute-force permutation enumeration for
n ≤ 7 in the tests). If different orders yield different conclusions, the
batch is reported with `ambiguous=true` (sticky in `status` output).

**WAL and recovery.** Every batch appends one WAL record
`{seq, events, hash}` (write + `fsync`), where `hash` chains the sequence
number, the previous hash, the tie-break-ordered events and the resulting
monitor-state snapshot (SHA-256 over canonical JSON). `checkpoint` writes
`{seq, hash, pattern, monitor}` atomically (tmp file + rename). The fault
point is "WAL written, checkpoint not written" — and also a torn final WAL
record. Recovery re-validates and replays the *entire* chain from genesis:
sequence numbers must be gap-free, every record hash must recompute, the
checkpoint must match the replayed state at its sequence number, and a torn
final record is truncated. The recovered `seq` is the last complete batch.

## Input format (JSONL)

```json
{"type":"init","pattern":"arm fire"}
{"type":"batch","events":[{"id":"e1","type":"arm"}]}
{"type":"checkpoint"}
{"type":"crash","torn":true}
{"type":"status"}
```

- `init` — safety property (required, first; or use `--pattern`)
- `batch` — one macro-step of simultaneous events (`id` unique per batch)
- `checkpoint` — persist a checkpoint of the current state
- `crash` — simulate a crash: drop memory, recover from WAL + checkpoint
  (`"torn":true` additionally leaves a half-written WAL record)
- `status` — print the current state

## Output format (JSONL, stdout)

One record per command: `init`, `batch`, `checkpoint`, `status` and
`recovered` (the answer to `crash`). State-carrying records look like:

```json
{"type":"status","seq":3,"state":"VIOLATION","ambiguous":false,"hash":"2e7b…"}
```

`ambiguous` on a `batch` record refers to that macro-step; on `status` /
`recovered` it is the sticky "ambiguity ever observed" flag.

## Exit codes

- `0` — ok
- `2` — usage error (missing/unreadable input, bad options)
- `12` — validation/integrity failure: **sequence gap** (`SEQ_GAP`),
  **hash mismatch** (`HASH_MISMATCH`), **duplicate event id in a
  macro-step** (`DUP_ID`), corrupt WAL/checkpoint, pattern mismatch,
  malformed input

## Layout

- `src/regex.js` — regex parser, Thompson NFA, deterministic DFA
- `src/monitor.js` — three-valued monitor, macro-step DP + brute-force reference
- `src/wal.js` — hash chain, WAL writer, checkpoint, recovery
- `src/engine.js` — monitor + WAL + checkpoint orchestration
- `cli.js` — CLI entry (`node cli.js mon.jsonl`)
- `test/` — `node:test` suites
- `examples/` — runnable example inputs

## Acceptance mapping

1. Order-sensitive batch → `ambiguous=true`: `test/monitor.test.js`
   ("acceptance 1"), `test/cli.test.js` ("CLI reports ambiguity").
2. Violation + backfill stays `VIOLATION`: `test/recovery.test.js`
   ("acceptance 2"), `test/monitor.test.js` ("VIOLATION is sticky").
3. Crash before checkpoint recovers to the last complete batch:
   `test/recovery.test.js` ("acceptance 3", torn-record and post-checkpoint
   variants), `test/cli.test.js` ("torn WAL tail").
4. Macro-step DP vs. full permutation enumeration for n ≤ 7:
   `test/monitor.test.js` (two "acceptance 4" tests, seeded PRNG).
5. `UNKNOWN` never reported as `SAFE`/UNSAT, no certificate fields:
   `test/monitor.test.js` ("acceptance 5"), `test/cli.test.js`
   (output-schema assertion).

## Real results (this machine, Node v22.22.1)

`node --test`:

```
ok 1 - test/cli.test.js
ok 2 - test/monitor.test.js
ok 3 - test/recovery.test.js
# tests 3
# pass 3
# fail 0
```

(24 subtests in total: 6 CLI, 10 monitor, 8 recovery — all passing.)

`node cli.js examples/mon.jsonl` (fresh directory; `arm` then `fire`
violates, checkpoint at seq 2, crash recovers to the last complete batch
seq 3 with the violation intact):

```
{"type":"init","pattern":"arm fire","seq":0,"hash":"8061e09e…44bd7f11"}
{"type":"batch","seq":1,"state":"UNKNOWN","ambiguous":false,"hash":"cc64b3cd…"}
{"type":"status","seq":1,"state":"UNKNOWN","ambiguous":false,"hash":"cc64b3cd…"}
{"type":"batch","seq":2,"state":"VIOLATION","ambiguous":false,"hash":"a0c0c5df…"}
{"type":"status","seq":2,"state":"VIOLATION","ambiguous":false,"hash":"a0c0c5df…"}
{"type":"checkpoint","seq":2,"hash":"a0c0c5df…"}
{"type":"batch","seq":3,"state":"VIOLATION","ambiguous":false,"hash":"2e7bcbef…"}
{"type":"recovered","seq":3,"state":"VIOLATION","ambiguous":false,"hash":"2e7bcbef…","replayed":3}
{"type":"status","seq":3,"state":"VIOLATION","ambiguous":false,"hash":"2e7bcbef…"}
```

`node cli.js examples/ambiguous.jsonl` (batch `{a1:fire, a2:arm}`: tie-break
order is SAFE, the other order violates → ambiguity reported, conservative
`VIOLATION`):

```
{"type":"init","pattern":"arm fire","seq":0,"hash":"8061e09e…"}
{"type":"batch","seq":1,"state":"VIOLATION","ambiguous":true,"hash":"255c16b6…"}
{"type":"status","seq":1,"state":"VIOLATION","ambiguous":true,"hash":"255c16b6…"}
```

Duplicate id in a macro-step:

```
{"type":"init","pattern":"a b","seq":0,"hash":"65977d10…"}
error[DUP_ID]: duplicate event id in macro-step: x
exit=12
```

## Limitations

- The exact macro-step analysis is exponential in the number of distinct
  event types per batch in the worst case (count-vector DP, capped at
  2,000,000 vectors; n ≤ 7 is covered by the permutation cross-check).
  Split oversized batches.
- The pattern is anchored at stream start; use `.*` prefixes (e.g.
  `.* a b`) if you need "match anywhere" semantics.
