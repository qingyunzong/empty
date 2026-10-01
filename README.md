# cfgdom

Build a control-flow graph (CFG) from linear bytecode and compute
dominator sets, immediate dominators, back edges, and loop headers.
Pure Python 3.11+ standard library; tests use `unittest`.

## CLI

```
python -m cfgdom prog.json --emit dom.json
```

- Exit code `0`: analysis written to `dom.json`.
- Exit code `8`: `CFGError` (bad edge, duplicate offset, empty program,
  unreadable/invalid input). The error message contains the offending
  `offset` and **no** `dom.json` is written.

## Input format

```json
{
  "instructions": [
    {"offset": 0, "op": "JZ",   "fallthrough": false, "targets": [12, 20]},
    {"offset": 12, "op": "RET", "fallthrough": false, "targets": []}
  ]
}
```

A bare top-level list of instructions is also accepted. `fallthrough`
defaults to `true`, `targets` to `[]`, `op` is optional. Instructions
with `op` of `HALT`/`RET` (or `fallthrough: false` with no targets) have
no successors.

## Semantics

1. **Block splitting** — leaders are: the entry instruction, every jump
   target, and the instruction following any jump or non-fallthrough
   instruction. Blocks are maximal fallthrough runs starting at leaders.
2. **Block ids** — assigned in offset order; the entry block is `id=0`.
   Blocks not reachable from the entry are kept and marked
   `"unreachable": true`.
3. **Dominators** — iterative fixed point: `dom(0) = {0}`,
   `dom(n) = {n} ∪ ⋂ dom(p)` over predecessors (empty intersection =
   universe, matching the vacuous path-based definition for unreachable
   blocks). `idom` is the strict dominator with the largest `dom` set;
   the entry block and unreachable blocks get `idom = null`.
4. **Back edges** — an edge `u -> v` where `v ∈ dom(u)`, computed over
   reachable blocks. Back-edge targets are the loop headers.
5. **Errors** — bad edge targets, duplicate offsets, and empty programs
   raise `CFGError` carrying the offending `offset`.

## Output format

```json
{
  "blocks": [{"id": 0, "start": 0, "end": 0, "offsets": [0],
              "successors": [1], "unreachable": false,
              "dom": [0], "idom": null}],
  "edges": [[0, 1]],
  "back_edges": [],
  "loop_headers": []
}
```

## Example (real output)

`examples/prog.json` is an if/else inside a loop, with dead code after
`RET`. Running `python -m cfgdom examples/prog.json --emit examples/dom.json`
(exit code 0) yields, summarised per block
(`id offsets successors unreachable dom idom`):

```
0 [0]  succ=[1]    unreachable=False dom=[0]             idom=None
1 [4]  succ=[2,3]  unreachable=False dom=[0,1]           idom=0
2 [12] succ=[4]    unreachable=False dom=[0,1,2]         idom=1
3 [20] succ=[4]    unreachable=False dom=[0,1,3]         idom=1
4 [24] succ=[1,5]  unreachable=False dom=[0,1,4]         idom=1
5 [28] succ=[]     unreachable=False dom=[0,1,4,5]       idom=4
6 [32] succ=[]     unreachable=True  dom=[0..6]          idom=None
back_edges=[[4,1]] loop_headers=[1]
```

The if/else join (block 4) is immediately dominated by the condition
block 1, the edge `4 -> 1` is the loop back edge, and block 1 is the
loop header. The `HALT` after `RET` stays in the output as unreachable.

Error case (real run):

```
$ python3 -m cfgdom bad.json --emit bad_dom.json   # targets [44], no such offset
CFGError: bad edge: target 44 has no instruction (offset=0)
exit=8        # and bad_dom.json is not created
```

## Tests

```
python -m unittest discover -s tests -v
```

Coverage includes the acceptance criteria:

- **A** `TestRandomGraphsAgainstBruteForce` — 500 sampled CFGs
  (n ≤ 6 blocks, ≤ 8 edges, seeded RNG) checked against the brute-force
  all-paths definition of dominance (dom sets, reachable idoms,
  back edges, loop headers).
- **B** `TestUnreachableBlocks` — an extra unreachable block does not
  change any reachable `dom`/`idom`.
- **C** `TestIfElseJoin` — the if/else join's `idom` is the condition
  block.
- **D** `TestBackEdges` — self loops, cross-block back edges, and
  nested loops.
- Plus block-splitting rules, `CFGError` cases, and CLI exit-code
  behaviour.

Real run on this machine (Python 3.14.4):

```
Ran 21 tests in 1.587s

OK
```

## Layout

- `cfgdom/core.py` — parsing, CFG construction, dominators, back edges.
- `cfgdom/__main__.py` — CLI entry point (`python -m cfgdom`).
- `tests/test_cfgdom.py` — `unittest` suite.
- `examples/prog.json`, `examples/dom.json` — sample input and real output.
