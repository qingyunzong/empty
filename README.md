# recipe-optimizer

Offline, single-machine DSL + bytecode VM for choosing minimum-cost
ingredient mixes under stock, quality and budget constraints, with an
auditable plan certificate. Node.js 22, standard library only.

## Usage

```sh
node src/cli.js optimize recipe.dsl --json plan.json
node src/cli.js verify plan.json
node --test          # run the test suite
```

`optimize` prints the plan JSON (and writes it with `--json`). `verify`
recompiles the DSL source embedded in the plan, re-solves, checks every
constraint margin against the stated recipe, and validates the certificate.

## Exit codes (observed)

| Code | Meaning |
| ---- | ------- |
| 0 | `OPTIMAL` plan produced / plan verified (`OK`) |
| 1 | generic failure: bad args, unreadable file, plan verification failed |
| 2 | DSL diagnostic; message is `file:line:col: error: ...` |
| 3 | `OVER_BUDGET`: feasible, but minimum cost exceeds `budget` |
| 4 | `INFEASIBLE`: no integer-gram recipe satisfies the hard constraints |

`INFEASIBLE` and `OVER_BUDGET` are never conflated: feasibility is decided
without the budget; the budget is only compared against the optimum
afterwards.

## DSL

```dsl
# comments with '#' or '//'
macro protein_floor = 80000 ppm;      # lexical scope, no recursive expansion

ingredient Flour {
  cost: 4 CNY / 1 kg;                 # currency per mass (or plain `0.004 CNY`)
  stock: 500 g;                       # inventory limit
  allergen: 30 ppm;                   # optional, default 0
  indicator protein: 120000 ppm;      # quality indicator, default 0 elsewhere
}

target: 200 g;        # mass conservation: grams sum to this
step: 20 g;           # grams are multiples of step (default 1 g)
budget: 2 CNY;        # optional
constraint protein in [protein_floor, 400000 ppm];
constraint fat <= 30000 ppm;
constraint cost <= 1.5 CNY;           # builtins: cost, mass, grams(Name)
minimize cost;
```

- Lexer units: `g`, `kg`, `ppm`, `CNY`, `¥` (1 CNY = 10^6 micro-CNY
  internally; all money math is exact integers).
- Static types track dimensions (mass / concentration / currency /
  currency-per-mass). `1 kg + 5 ppm` and `cost * cost` are compile-time
  errors with line:col.
- Macros are expanded lazily in their defining lexical scope; ingredient
  bodies are nested scopes; cyclic expansion is a diagnostic.
- `grams(Name)` inside constraints references an ingredient; undeclared
  names are diagnostics.

## Solving and tie-breaks

Constraints and the objective compile to stack bytecode; the VM evaluates
candidate integer-gram recipes. The solver enumerates recipes exactly
(branch-and-bound over compositions of `target/step`) and minimizes total
cost. Ties break by (1) lower allergen total `sum(grams_i * allergen_ppm_i)`,
then (2) the lexicographically smaller gram vector with ingredients ordered
by name — e.g. `(A=0, B=100)` beats `(A=100, B=0)`.

## Plan certificate

`plan.json` embeds the DSL source, per-ingredient grams, cost, allergen
total, per-constraint margins (slacks), and `certificate`: SHA-256 of the
canonical JSON of all other fields. `verify` exits 1 on any tampering.

## Tests

`node --test` — 6 files, 38 tests, all passing (last run: 38 pass / 0 fail):

- `test/lexer.test.js` (4): units, comments, line/col tracking
- `test/parser.test.js` (5): Pratt precedence, ranges, blocks
- `test/check.test.js` (10): kg+ppm mismatch, macro cycles, lexical scoping,
  undeclared ingredients
- `test/solver.test.js` (9): agreement with a naive enumeration reference
  (up to 8 ingredients, 10–20 g steps), both tie-break rules, budget
  exactly-equal vs one-micro-below, INFEASIBLE vs OVER_BUDGET separation
- `test/cli.test.js` (7): end-to-end optimize/verify, exit codes, tampered
  plans
- `test/vm.test.js` (3): bytecode semantics

Note: the test sandbox drops piped stdout of nested node processes, so CLI
tests capture child output through temp files.
