# knnindex — exact rational branch-and-bound KNN index

A pure Python 3.11 (stdlib-only) library + JSON CLI for **exact** top-K
nearest-neighbour search over rational-coordinate vectors, with boolean label
filtering, node budgets, resumable cursors, snapshots and persistence.

## Guarantees

- **Exact arithmetic only.** All coordinates, squared Euclidean distances and
  bounding-box bounds are `fractions.Fraction`. No float ever participates in
  a distance or pruning decision.
- **Exact top-K, never approximate.** Candidates enter the result only after
  their exact squared distance is known. Results are ordered by
  `(distance, id)`. Ties at the K-th boundary are fully explored.
- **Safe pruning.** Node bounding boxes give certified lower bounds
  (`box_dist2`); tag summaries (`present`/`absent` unions) only ever prune a
  subtree when *no* member can satisfy the filter. Deletions shrink boxes
  lazily — a box may stay loose but can never shrink past a live point.
- **Honest budgets.** A node budget caps work; when it runs out the result is
  `status: "unknown"` with the best candidates found so far — never presented
  as exact — plus lower-bound certificates for every unvisited subtree and a
  resumption cursor bound to the data version.
- **Verifiable.** `knnindex.verify` independently recomputes ground truth by
  full scan and checks every certificate bound against the certified
  subtree's true bounding box; inflated/tampered bounds are rejected.

## Library

```python
from knnindex import KNNIndex

idx = KNNIndex(dims=2)
idx.insert("a", ["1/2", 3], labels=["red", "round"])
idx.insert("b", [2, "3/4"], labels=["red"])
idx.replace("b", [2, 1], labels=["blue"])      # atomic version replace
idx.delete("a")

r = idx.query([0, 0], k=5, filter={"and": [{"tag": "red"}, {"not": {"tag": "round"}}]},
              budget=1000)
r.status          # "complete" | "unknown"
r.hits            # [(Fraction dist2, id), ...] sorted
r.certificates    # lower-bound certs for pruned/deferred subtrees

snap = idx.snapshot()          # pin a version
idx.save("db.json")            # persist (JSON, exact rational strings)
idx2 = KNNIndex.load("db.json")
cursor = idx.cursor_for(r, [0, 0], 5)   # only when r.status == "unknown"
idx.resume(cursor, budget=1000)          # bound to the cursor's data version
```

## CLI

```sh
python3.11 -m knnindex.cli create --db db.json --dims 2
python3.11 -m knnindex.cli insert --db db.json --id a --coords "1/2,3" --labels red,round
python3.11 -m knnindex.cli query  --db db.json --coords "0,0" --k 5 \
    --filter '{"tag": "red"}' --budget 1000
python3.11 -m knnindex.cli verify --db db.json --coords "0,0" --k 5
python3.11 -m knnindex.cli resume --db db.json --cursor cursor.json
```

All commands emit JSON. Filter expressions: `{"tag": t}`, `{"not": e}`,
`{"and": [...]}`, `{"or": [...]}`, `{"all": true}`, `{"none": true}`.

## Tests

```sh
python3.11 -m unittest discover -s tests -v
```

The suite cross-checks every boolean filter combination against an independent
full scan on small data, and covers boundary ties, duplicate coordinates,
huge coordinates, nearest-point deletion, summary invalidation, K > hits,
zero budget, tampered certificates, and real node-visit counts on a
3000-point sample.
