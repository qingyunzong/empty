# RESULTS

Environment: Node.js v22.22.1, standard library only, offline. Date: 2026-10-08.

## Test suite (`node --test`)

```
ok 1 - acceptance 1: three orders, two machines, basic feasible flow
ok 2 - acceptance 2: slow(machine, factor) drops value and migrates bottleneck cut
ok 3 - acceptance 3: insert order, undo restores original value; commit protects state
ok 4 - acceptance 4: max-flow value matches brute-force cut enumeration (n<=8)
ok 5 - acceptance 5: time-window overlap, negative capacity, duplicate commit errors
ok 6 - CLI: JSONL in, JSONL out, including error codes
ok 7 - scale: 150 orders x 300 slots solves quickly and verifies
# tests 7
# pass 7
# fail 0
# duration_ms ~770
```

## Acceptance mapping

1. **Three orders, two machines** — test 1: demands 6/5/4 vs capacities 10+8,
   `flow` returns `value=15`, assignments sorted by (order id, start), and
   `verify` passes all four checks with `cut_value == value`.
2. **Slowdown drops value, bottleneck migrates** — test 2: two orders of 10 on
   slots of 12 (m1) and 8 (m2) gives `value=20` with the cut on the order side
   (`orders: [o1, o2]`). After `slow m1 0.5` the value drops to `14` and the
   bottleneck cut migrates to the machine slots (`slots: [s1, s2]`,
   cut edges `s1->sink: 6`, `s2->sink: 8`).
3. **Insert then undo restores value** — test 3: base `value=20`, rush order
   insertion raises it to `25`, two `undo`s restore exactly `20`; after
   `commit`, `undo` answers `UNDO_EMPTY` and the committed plan is intact.
4. **Brute-force cross-check (n<=8)** — test 4: 40 seeded random instances
   (1-8 orders, 1-8 slots, random links incl. finite link capacities, random
   slowdowns); max-flow value equals an exhaustive enumeration of all
   `2^orders x 2^slots` s-t cuts to within 1e-6, and `verify` passes.
5. **Error cases** — test 5: link outside the order time window, overlapping
   slots on one machine, negative/zero demand or capacity, bad slow factor,
   unknown references -> `INVALID_INPUT`; duplicate `commit` -> `CONFLICT`;
   `undo` on empty stack -> `UNDO_EMPTY`.

## CLI demo (real output)

Input: two orders of 10, slots 12 (m1) + 8 (m2), commit, flow, slow m1 0.5,
flow, verify, undo, flow, undo, commit.

```
{"cmd":"flow"}    -> value=20, bottleneck_cut.orders=[o1,o2]      (demand side)
{"cmd":"slow"}    -> ok
{"cmd":"flow"}    -> value=14, bottleneck_cut.slots=[s1,s2]       (machine side, migrated)
{"cmd":"verify"}  -> ok, all checks true, cut_value=14 == value
{"cmd":"undo"}    -> ok
{"cmd":"flow"}    -> value=20 restored
{"cmd":"undo"}    -> UNDO_EMPTY  (committed plan protected)
{"cmd":"commit"}  -> CONFLICT    (nothing pending)
```

## Scale

150 orders x 300 slots (600 links): max flow + min cut + verify in well under
1 s (test 7 asserts < 2 s; measured ~0.6 s for the whole scale test including
network construction).
