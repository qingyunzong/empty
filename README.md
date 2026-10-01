# detrand

Deterministic random operation streams for driving state machines under test.
Pure Python 3.11+ standard library; the only randomness source is
`random.Random`. No wall-clock time, pid, or `hash()` is used, so output is
independent of `PYTHONHASHSEED` and byte-identical across processes for the
same seed and spec.

## Usage

```sh
python -m detrand run spec.json --seed 7 --steps 200 --record run.jsonl
python -m detrand replay run.jsonl
```

- `run` generates an operation stream from the spec, records every step
  (`op`, `args`, `digest`) as JSONL, and exits non-zero on invariant
  violations, archiving `failure.json` with `seed`, `path`, and
  `last_digest`.
- `replay` re-executes the recorded run from its embedded header
  (spec + seed) and verifies every recorded field and digest.

## Spec format

```json
{
  "states": ["idle", "running"],
  "initial": "idle",
  "vars": {"count": 0},
  "transitions": {"idle": ["start"], "running": ["bump", "burst"]},
  "ops": {
    "start": {"to": "running"},
    "bump": {
      "to": "running",
      "guard": "count < 100",
      "args": {"n": {"kind": "int", "lo": 1, "hi": 5},
               "c": {"kind": "choice", "options": ["x", "y"]}},
      "effect": "count += n"
    },
    "burst": {"to": "running", "fork": {"name": "sub", "draws": 3}}
  },
  "invariants": ["count >= 0"]
}
```

- Op selection uses the parent stream (no draw is consumed when only one
  op is available); `args` of kind `int`/`choice` draw from the parent
  stream in sorted-arg order.
- `fork` derives a child stream from SHA-256 of
  `(parent seed, parent draw position, fork name)` and never consumes
  parent random numbers, so the parent sequence matches a hand-made
  `random.Random(seed)` reference stream.
- Each step digest chains SHA-256 over the previous digest and the
  canonical JSON of `{step, state, vars}`.

## Exit codes

| code | error        | meaning                                  |
|------|--------------|------------------------------------------|
| 0    | —            | run/replay succeeded                     |
| 2    | E_SPEC       | spec unreadable or invalid               |
| 3    | E_REPLAY     | record file missing or malformed         |
| 4    | E_DIVERGE    | replay does not match the record         |
| 5    | E_INVARIANT  | invariant violated (run or reproduced)   |

## Tests

```sh
python -m unittest discover -s tests -v
```
