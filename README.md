# binpack

Deterministic 2D rectangle bin packing with two strictly separated modes:
an exact minimum-bin solver for small instances and a first-fit heuristic.
Python 3.11+ standard library only.

## Usage

```
python -m binpack pack items.json --bins bins.json --out plan.json --mode exact|firstfit
```

- `items.json`: `[{"id": ..., "w": int, "h": int, "rotate": bool}, ...]`
  (`rotate` optional, default `false`)
- `bins.json`: `[{"id": ..., "W": int, "H": int, "count": int}, ...]`
  (`count` optional, default `1`)
- Rectangles are axis-aligned and must not overlap. An item is placed
  rotated by 90° only when its `rotate` flag is true.

## Semantics

- **exact**: guaranteed to find the minimum number of bins only when the
  total item area is `<= 64` and there are `<= 10` items. Otherwise it
  returns status `TOO_LARGE` (never an approximate answer). Among all
  minimum-bin solutions it picks the lexicographically smallest used bin-id
  sequence, then the lexicographically smallest placement vector (items in
  ascending id order, compared by `(bin, x, y, rotated)`), so results are
  deterministic and byte-identical across runs.
- **firstfit**: items are placed in ascending id order; bin copies are
  scanned in `(bin id, copy index)` order; candidate positions (corner
  points) are scanned in `(x, y)` lexicographic order; at each position both
  orientations are tried in `(unrotated, rotated)` order when `rotate` is
  true. The first feasible spot wins. It may use more bins than `exact` and
  may report `INFEASIBLE` even when a packing exists.

## Output

`plan.json` always contains `status` and `mode`:

- `OK`: plus `used_bins` (`[{"id", "copy"}]`) and `placements`
  (`[{"item", "bin", "copy", "x", "y", "rotated"}]`, sorted by item id).
- `TOO_LARGE` / `INFEASIBLE`: no `used_bins`/`placements` fields.

## Exit codes (measured)

| Situation                                   | Exit code |
|---------------------------------------------|-----------|
| `status` is `OK`, `TOO_LARGE` or `INFEASIBLE` | `0`     |
| Non-positive item/bin dimension             | `2`       |
| Negative `count`                            | `2`       |
| Invalid `--mode` (argparse `choices`)       | `2`       |
| Missing/invalid JSON input, unreadable file | `2`       |

## Example (files in `examples/`)

```
$ python -m binpack pack examples/items.json --bins examples/bins.json --out examples/plan-exact.json --mode exact
exact: OK -> examples/plan-exact.json        # exit 0, 1 bin used
$ python -m binpack pack examples/items.json --bins examples/bins.json --out examples/plan-firstfit.json --mode firstfit
firstfit: OK -> examples/plan-firstfit.json  # exit 0, 2 bins used
```

Same input, different results — exact finds the 1-bin optimum while
first-fit fragments the bin and needs 2. Recorded plan hashes
(`sha256sum`, plans written with `indent=2, sort_keys=True`):

- `examples/plan-exact.json` (status `OK`, 1 bin):
  `cff7d98f46c4e46d6e96fcecfd7f0ce7d97c9f32ac4ecc509252a54450e6fbdd`
- `examples/plan-firstfit.json` (status `OK`, 2 bins):
  `0a2e0e5d6d06547f111013ed27975723dcce349753f5acf2af5c74bfd87a858d`

Error-case runs (real output):

```
$ python -m binpack pack bad-items.json --bins examples/bins.json --out p.json --mode exact
error: items[0] has non-positive dimension 0x2   # exit 2
$ python -m binpack pack examples/items.json --bins examples/bins.json --out p.json --mode bogus
... "invalid choice: 'bogus'" ...                 # exit 2
$ python -m binpack pack big.json --bins bigbin.json --out p.json --mode exact
exact: TOO_LARGE -> p.json                        # exit 0, area 65 > 64
```

## Tests

```
python -m unittest discover -s tests -v
```

Covers: (A) 4 items needing 2 bins with exact/firstfit asserted separately,
(B) `rotate=false` infeasible vs `rotate=true` feasible, (C) area 65 →
`TOO_LARGE`, (D) exact bin counts cross-checked against an independent
backtracking enumeration in the test suite for 25 random small cases,
(E) identical exact input run 5× via the CLI produces byte-identical plans,
plus tie-break determinism and exit-code-2 validation errors.

Last run: `Ran 13 tests ... OK`.
