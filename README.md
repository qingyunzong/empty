# config-merge

Layered config merging library (TypeScript, Node.js built-ins only, zero dependencies).
Layers are ordered from lowest to highest priority; higher layers override lower ones.

## Merge rules

1. **Objects merge recursively** — plain objects merge key by key.
2. **Arrays merge by stable id** — elements that are objects with an `id` key
   (configurable via `idKey`) merge recursively by id; unmatched elements
   append in override order; base order is preserved. Elements without an id
   append as-is.
3. **Explicit deletion** — set a key to the exported `DELETE` symbol or to
   `{ $delete: true }`; array elements are deleted with
   `{ id: "x", $delete: true }`. Deleting an item that does **not** exist in
   lower layers still keeps a **tombstone** inside the merged node, so the
   deletion shadows any ancestor base the result is later merged onto.
   Tombstones are stripped by `materialize` / in the `mergeAll` result value.
4. **Type change replaces** — if a layer changes a value's kind
   (object / array / scalar, `null` counts as scalar), the higher layer
   replaces the whole subtree.

## Provenance

`mergeAll` returns `{ value, report, tombstones }`. `report` lists every item
of the final config with the decisive layer index and the rule that produced
it (`add`, `override`, `merge`, `id-merge`, `append`, `type-replace`);
`tombstones` lists deletions (`delete` for existing items, `tombstone` for
items absent from lower layers). `examples/three-layer.ts` prints a
three-layer vs. final comparison table with these rule explanations, and
cross-checks that `merge(merge(L0,L1),L2) === merge(L0,merge(L1,L2)) ===
mergeAll([L0,L1,L2])`.

## API

```ts
import { DELETE, merge, mergeAll, mergeNodes, materialize } from './src/merge.js';

merge(base, override, { idKey? });      // two layers -> { value, report, tombstones }
mergeAll([l0, l1, l2], { idKey? });     // n layers, low -> high priority
mergeNodes(a, b);                       // low-level: internal node (keeps tombstones)
materialize(node);                      // strip tombstones -> plain config
```

## Scripts

- `npm test` — type-check/compile with `tsc`, then run `node --test`
- `npm run demo` — three-layer merge demo with the provenance/rule table

## Test results (actual run, Node v22.22.1)

`npm test` → 23/23 passing:

```
ok 1 - objects merge recursively, scalars override
ok 2 - inputs are never mutated
ok 3 - type change replaces the whole subtree (object -> scalar)
ok 4 - type change replaces the whole subtree (scalar -> object)
ok 5 - type change replaces the whole subtree (object -> array)
ok 6 - null is a scalar value and replaces objects
ok 7 - array elements with the same id merge recursively, order preserved
ok 8 - array elements with new ids append in override order
ok 9 - unkeyed array elements append
ok 10 - custom idKey is honored
ok 11 - DELETE symbol removes an existing key
ok 12 - { $delete: true } marker removes an existing key
ok 13 - deleting a non-existent key keeps a tombstone that shadows ancestors
ok 14 - array element delete by id
ok 15 - array delete of non-existent id keeps tombstone and shadows ancestor
ok 16 - re-adding after delete resurrects the item
ok 17 - array delete marker without id throws
ok 18 - provenance reports the decisive layer and rule per item
ok 19 - provenance records type-replace and delete
ok 20 - tombstone rule used when deleting a non-existent item
ok 21 - three-layer merge produces the expected config
ok 22 - sequential fold equals one-shot mergeAll (associativity)
ok 23 - tombstone for never-existent array id survives three-layer merge
# pass 23
# fail 0
```

`npm run demo` tail:

```
=== tombstones (kept internally to shadow ancestors) ===
features.legacy  deleted-by=L1  rule=delete
servers[id="cache"]  deleted-by=L1  rule=delete
servers[id="ghost"]  deleted-by=L2  rule=tombstone

=== cross-check: sequential fold vs one-shot mergeAll ===
merge(merge(L0,L1),L2) === merge(L0,merge(L1,L2)) === mergeAll([L0,L1,L2])  OK
tombstone for features.legacy shadows ancestor base  OK
```
