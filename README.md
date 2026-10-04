# bareiss — exact integer linear algebra

Exact linear analysis over the integers with the Bareiss fraction-free
elimination algorithm and complete pivoting.  Pure Python 3.11 standard
library; no third-party dependencies.

Every conclusion distinguishes the three classical cases and backs it with
an independently checkable artifact:

| case            | delivered artifacts                                   |
|-----------------|-------------------------------------------------------|
| unique solution | particular solution (exact `Fraction`s)               |
| infinite        | particular solution + integer null-space basis        |
| inconsistent    | integer certificate `y` with `yᵀA = 0`, `yᵀb ≠ 0`     |

## Features

- **Bareiss fraction-free elimination with complete pivoting** — all
  arithmetic stays in `int`; every exact division is *checked*
  (`BareissIntegralityError` on failure) and never silently truncated.
- **Rank, determinant, multi-RHS solve, null-space basis, inconsistency
  certificates** from one factorization.
- **Full elimination log**: row/column permutations, per-step pivots,
  swaps, and recorded elimination columns are kept in
  `Factorization.steps`; the determinant sign accounts for every swap.
- **Singular pivots handled correctly**: complete pivoting moves past
  zero pivots; only a genuinely all-zero remaining block ends the
  factorization (recorded in `notes`), so rank is never misreported.
- **Incremental updates**: `LinearSystem.updated(replace_rows=…,
  add_rows=…)` returns a new snapshot that reuses the still-valid prefix
  of the old factorization.  A cached step is rejected (and the affected
  suffix recomputed) when its pivot vanished, when the cached pivot value
  is stale for an untouched row, or when an exact division fails; the
  state is rolled back to just before the bad step first.  Old snapshots
  remain fully queryable.
- **Checkpoints**: `save_checkpoint` / `load_checkpoint` serialize the
  complete factorization to JSON; reloaded snapshots answer queries and
  accept further updates.
- **Independent verification**: `bareiss.verify` re-checks solutions,
  null bases, and certificates by plain exact matrix multiplication, and
  `bareiss.reference` is a separate `Fraction` Gaussian-elimination
  implementation used to cross-check the engine in tests.

## Library usage

```python
from bareiss import LinearSystem

system = LinearSystem([[1, 2], [2, 4]])
system.rank                 # 1
sol_ok, sol_bad = system.solve([[3, 6], [3, 7]])
sol_ok["status"]            # "infinite"
sol_ok["null_basis"]        # [[2, -1]]
sol_bad["status"]           # "inconsistent"
sol_bad["certificate"]      # y with yᵀA = 0, yᵀb ≠ 0

bigger = system.updated(add_rows=[[1, 1]])   # new snapshot, prefix reused
bigger.rank                 # 2
system.rank                 # 1  (old snapshot unchanged)
```

## JSON CLI

Reads one JSON request from a file argument or stdin, writes JSON to
stdout:

```sh
echo '{"command": "analyze",
       "matrix": [[2, 1, -1], [-3, -1, 2], [-2, 1, 2]],
       "rhs": [[8, -11, -3]],
       "checkpoint_out": "cp.json"}' | python3.11 -m bareiss

echo '{"command": "update", "checkpoint_in": "cp.json",
       "replace_rows": {"2": [-2, 1, 5]},
       "rhs": [[8, -11, 0]]}' | python3.11 -m bareiss
```

The response contains `rank`, `determinant` (square matrices), the
permutations, the full `elimination_log`, per-RHS `solutions` with
status/particular/null-basis/certificate, and independent `verification`
results.  Fractions are encoded as `"p/q"` strings, integers as integers.

## Layout

- `bareiss/core.py` — factorization, solving, updates, checkpoints
- `bareiss/verify.py` — independent matrix-multiplication verifier
- `bareiss/reference.py` — independent `Fraction` Gaussian elimination
- `bareiss/cli.py` — JSON command-line interface
- `tests/` — unittest suite (32 tests)

## Test run (recorded 2026-10-04, Python 3.11.16)

```
$ python3.11 -m unittest discover -s tests -v
...
Ran 32 tests in 1.4s

OK
```

Coverage includes: determinant sign under multiple row/column swaps
(checked against the Leibniz formula), singular pivots with nonzero
trailing blocks, rank-deficient matrices with mixed solvable/unsolvable
right-hand sides, huge common factors (`g·A` with `g ~ 10³⁸`), updates
that raise and lower the rank, stale/corrupt cache rejection with
rollback and recompute, checkpoint save/reload round-trips, and
randomized cross-checks of rank, determinant, solution status, null
spaces, and certificates against the independent `Fraction` reference
implementation.
