# shed — offline load-shedding optimizer

Decides, for a given power deficit, at which stage each load is shed. Stages
form a finite domain `0..K` per load (stage `s` sheds `power * s / K`). The
solver propagates feeder cumulative capacity and interlock constraints over
those domains, then backtracks (branch & bound) to the optimal plan: shed the
least at the highest importance level first; ties within a level are broken by
load id (smaller ids are spared first).

Pure Node.js 22 standard library; tests use `node:test`.

## Model format

```json
{
  "feeders": [
    {
      "id": "F1",
      "capacity": 150,
      "loads": [
        { "id": "L1", "power": 100, "level": 1, "maxStage": 2 }
      ]
    }
  ],
  "interlocks": [
    { "type": "together", "loads": ["L4", "L5"] },
    { "type": "order", "first": "L2", "then": "L3" },
    { "type": "noshed", "load": "L6" }
  ]
}
```

- `capacity`: maximum cumulative shed allowed on the feeder.
- `level`: importance; lower levels are shed first.
- `maxStage`: `K`, the load's stage domain is `0..K`. Optional `"stage": s`
  pins a load to a fixed stage.
- `together`: all listed loads share the same stage.
- `order`: `first` is shed no later than `then` (`stage(first) >= stage(then)`).
- `noshed`: the load must keep running (stage fixed to 0).

## CLI

```
shed model.json --gap 120 --budget 300
```

Exit codes:

| code | status      | meaning                                             |
|------|-------------|-----------------------------------------------------|
| 0    | `optimal`   | verified optimal plan, JSON on stdout               |
| 1    | `infeasible`| no stage combination meets the gap; minimal conflict|
| 2    | invalid     | bad input (negative power, unknown load, non-integer stage, ...) |
| 3    | `unknown`   | branch budget exhausted; `pending` lists undecided loads |

`unknown` is never reported as `infeasible`.

## Tests

```
node --test
```

- `test/solver.test.js` cross-checks the solver against exhaustive enumeration
  of all stage combinations on random 3–5 load instances, verifies minimal
  conflicts for interlock-blocked gaps, and reproduces `unknown` with a tiny
  budget plus a verifiable plan with a larger one.
- `test/cli.test.js` checks CLI output and exit codes 0/1/2/3.
