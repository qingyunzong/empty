# binpack

Deterministic 2D rectangle bin packing. Python 3.11+ standard library only.

## Usage

```
python -m binpack pack items.json --bins bins.json --out plan.json --mode exact|firstfit
```

- `items.json`: `[{"id": str, "w": int, "h": int, "rotate": bool}, ...]`
  (`rotate` optional, defaults to `false`)
- `bins.json`: `[{"id": str, "W": int, "H": int, "count": int}, ...]`
- `plan.json`: `{"status": "OK", "used_bins": [...], "placements": [...]}`,
  or `{"status": "TOO_LARGE"}` / `{"status": "INFEASIBLE"}`.

Rectangles never overlap and are only rotated when `rotate=true`.

## Semantics

- **exact**: guarantees the minimal number of bins only when
  `total item area <= 64` **and** `items <= 10`; otherwise returns
  `TOO_LARGE` (never an approximation). Ties between optimal solutions
  are broken deterministically: first by the lexicographically smallest
  sorted sequence of used bin ids, then by the lexicographically smallest
  placement list (placements ordered by item id, each compared as
  `(bin_slot, rotated, x, y)`).
- **firstfit**: items in ascending `id` order; bin copies in
  `(bin id, copy index)` order; orientations in `(false, true)` order;
  positions in lexicographic `(x, y)` order — first feasible point wins.
- Candidate positions are corner points of placed rectangles
  (`{0} ∪ {right edges}` × `{0} ∪ {top edges}`); the lexicographically
  first feasible integer point is always such a corner point, so this
  changes nothing about which point is selected.
- `INFEASIBLE` is returned when no valid packing exists (exact) or the
  greedy pass fails to place some item (firstfit).

## Exit codes (measured)

| scenario                                   | exit | plan status |
|--------------------------------------------|------|-------------|
| valid input, packable                      | 0    | `OK`        |
| valid input, unpackable                    | 0    | `INFEASIBLE`|
| exact guard exceeded (area>64 or items>10) | 0    | `TOO_LARGE` |
| non-positive `w`/`h`/`W`/`H`               | 2    | — (stderr)  |
| `count < 0`                                | 2    | — (stderr)  |
| invalid `--mode`                           | 2    | — (usage)   |
| malformed JSON / missing fields            | 2    | — (stderr)  |

## Example (this repo, actually executed)

`examples/items.json` = 4 items (2x2, 4x4, 4x1, 2x4),
`examples/bins.json` = bin `B` 4x5 x4.

```
$ python -m binpack pack examples/items.json --bins examples/bins.json --out examples/plan.exact.json --mode exact
exit=0  status=OK  used_bins=2
sha256(plan.exact.json)   = 93f4492ebcbe5da0f26c436052df34b5c954d579792a5733320206affc029eb0

$ python -m binpack pack examples/items.json --bins examples/bins.json --out examples/plan.firstfit.json --mode firstfit
exit=0  status=OK  used_bins=3
sha256(plan.firstfit.json)= 7a8e6cb03f302500efc76e0199b7332b031c29a30ac020462b2ae56900be6990
```

The same input yields 2 bins under `exact` but 3 under `firstfit` —
the optimal and heuristic results are strictly separated.

## Tests

```
python -m unittest discover -s tests -v
```

Last run: **18 tests, OK** (~1.5 s). Coverage:

- **A** 4 items needing 2 bins: `exact` → 2, `firstfit` → 3, asserted separately.
- **B** `rotate=false` → `INFEASIBLE`, `rotate=true` → `OK` (both modes).
- **C** total area 65 → `TOO_LARGE`; 11 items → `TOO_LARGE`.
- **D** random cases with `items <= 8`: exact bin count checked against an
  independent brute-force backtracking enumerator in the test suite.
- **E** identical exact input, 5 CLI runs → byte-identical `plan.json`.
- Validation: non-positive dimensions, `count < 0`, invalid mode → exit 2.
- Tie-breaks: smallest bin-id sequence, then placement lexicographic minimum.
