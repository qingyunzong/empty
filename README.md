# detrand

Deterministic random operation streams for driving state machines under test.
Python 3.11+, standard library only.

## Usage

```sh
python -m detrand run spec.json --seed 7 --steps 200 --record run.jsonl
python -m detrand replay run.jsonl
```

`run` generates a deterministic op stream from `spec.json` + `--seed`, applies
it to the spec's state machine, and records every step as JSONL. `replay`
re-executes the record from its embedded spec+seed and verifies every digest.

## Spec format

```json
{
  "initial": {"count": 0},
  "ops": [
    {"name": "add", "kind": "int", "min": 1, "max": 9,
     "apply": "state['count'] += arg"},
    {"name": "note", "kind": "choice", "choices": ["a", "b"],
     "apply": "state['log'].append(arg)"},
    {"name": "burst", "kind": "fork", "substeps": 3,
     "subops": [{"name": "add", "kind": "int", "min": 1, "max": 3,
                 "apply": "state['count'] += arg"}]}
  ],
  "invariants": ["state['count'] >= 0"]
}
```

- `int` op: arg = `randint(min, max)`; `choice` op: arg = one of `choices`.
- `fork` op: derives a child seed from `(parent_seed, step_index, op_name)`
  via SHA-256 and runs `substeps` sub-ops on a private `random.Random`.
  It consumes **nothing** from the parent stream.
- `apply` is a Python statement evaluated with `state` and `arg` in scope
  (restricted builtins). `invariants` are boolean expressions over `state`,
  checked after every step.

## Determinism guarantees

- Only `random.Random` is used as a random source; no time, pid, or `hash()`.
- All JSON is canonical (sorted keys, fixed separators); digests are SHA-256
  of canonical state JSON. Output bytes are identical across processes and
  across `PYTHONHASHSEED` values.

## Errors and exit codes

| Code        | Exit | Meaning                                        |
|-------------|------|------------------------------------------------|
| `E_SPEC`    | 2    | invalid or unreadable spec                     |
| `E_REPLAY`  | 3    | record missing, malformed, or truncated        |
| `E_DIVERGE` | 4    | replay digest mismatch, or invariant violated  |

On invariant violation (run or replay), a failure archive (default
`failure.json`) is written with `seed`, `path`, `last_digest`, `step`, and
the violated invariant; the record keeps a `failure` line so replay
reproduces the same failure.

## Tests

```sh
python -m unittest discover -s tests -v
```
