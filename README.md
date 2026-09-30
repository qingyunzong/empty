# PN-Counter CRDT with node removal

State-based PN-Counter (Python 3.11 stdlib only) supporting membership
removal with tombstones.

## Semantics

- `inc/dec(node, k)`: only live members may write; `k` must be a positive
  integer, otherwise `BAD_DELTA`.
- `value() = sum(P) - sum(N)`, including contributions of removed nodes
  that were causally observed.
- `remove_node(node, voters)`: requires a strict majority of live members.
  Afterwards writes to `node` fail with `REMOVED`, but its historical
  increments still merge (tombstone, never resurrected).
- `merge` is commutative, associative and idempotent, and never drops
  causally-known increments of removed nodes.
- Rejoining with a retired ID fails with `ID_RETIRED`; a replacement node
  must use a fresh ID and starts from 0.

## CLI

`python3 cli.py` reads JSON lines on stdin, one result line per command;
exit code is 8 if any command failed.

```
{"cmd": "add",    "replica": "r1", "node": "A"}
{"cmd": "inc",    "replica": "r1", "node": "A", "k": 3}
{"cmd": "dec",    "replica": "r1", "node": "A", "k": 2}
{"cmd": "remove", "replica": "r1", "node": "B", "voters": ["A", "C"]}
{"cmd": "merge",  "replica": "r1", "from": "r2"}
{"cmd": "value",  "replica": "r1"}
{"cmd": "state",  "replica": "r1"}
```

## Tests

```
python -m unittest discover -s tests -v
```
