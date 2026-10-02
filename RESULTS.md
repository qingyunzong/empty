# RESULTS

Date: 2026-10-03. Environment: Node.js v22.22.1, offline, standard library only.

## `node --test`

```
ok 1 - 1. three orders, two machines: basic feasible flow with certificate
ok 2 - 2. slowdown drops value and migrates the bottleneck to machine capacity
ok 3 - 3. rush order then undo restores the original value; commit protects the plan
ok 4 - 4. max flow matches brute-force machine-assignment enumeration (n <= 8)
ok 5 - 5. overlapping windows, negative capacity and repeated commit are rejected
ok 6 - cancel and slow are undoable corrections
ok 7 - CLI processes JSONL and reports per-command results
# tests 7
# pass 7
# fail 0
```

## Acceptance criteria

1. **Three orders, two machines, basic feasible** — value 15 (3 x 5),
   bottleneck cut on order demands, assignments sorted by (order id, slot
   start), `verify` returns all four checks true.
2. **Slowdown drops value, bottleneck migrates** — 2 orders x 10 on
   M1(10)+M2(10): value 20 -> `slow M1 0.5` -> value 15, and
   `bottleneck_cut.slots` goes from `[]` (demand-bound) to `["s1","s2"]`
   (machine-capacity-bound); undo restores 20.
3. **Rush order + undo restores original value** — base plan committed at
   value 6; inserted order raises value to 10; two undos restore value 6;
   further undo returns `UNDO_EMPTY` and the committed plan is intact.
4. **Brute-force cross-check (n <= 8)** — 25 seeded random instances
   (2-3 orders, 2-3 slots, up to 8 links, integer capacities <= 3) match an
   exhaustive enumeration of integer link flows exactly.
5. **Error reporting** — overlapping slot windows on one machine, negative
   demand/capacity, link outside the order window -> `INVALID_INPUT`;
   repeated `commit` and duplicate ids -> `CONFLICT`; `undo` with empty
   journal -> `UNDO_EMPTY`.

## Scale check (orders = 150, slots = 300, links = 15000)

```
flow(150 orders, 300 slots, 15000 links): ~260 ms
verify: ~40 ms
slow + full recompute: ~190 ms
```

## CLI smoke test (real run, `node src/cli.js demo.jsonl`)

Committed 2 orders x 10 on M1(10)+M2(10), then `slow M1 0.5`, then undo:

```
{"cmd":"flow"}    -> {"status":"OK","value":20,...,"bottleneck_cut":{"value":20,"orders":[],"slots":[]}}
{"cmd":"verify"}  -> {"status":"OK","valid":true,"checks":{"conservation":true,"capacity":true,"time_window":true,"cut_equals_flow":true}}
slow + flow       -> value 15, bottleneck_cut {"orders":["o1","o2"],"slots":["s1","s2"]}
undo + flow       -> value 20 (restored)
commit (empty)    -> {"status":"CONFLICT","error":"nothing to commit"}
undo (protected)  -> {"status":"UNDO_EMPTY","error":"no uncommitted correction to undo"}
```
