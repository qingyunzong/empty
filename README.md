# stable-id-text

A small TypeScript text-editing model where selections are anchored to
**stable character ids** instead of offsets, with paged storage and
order-independent op-log merge/replay.

## Model

- **Stable character ids** — every character gets a permanent `CharId` at
  insertion time (`c:<site>#<counter>`). Ids never change, no matter how the
  text is edited or stored.
- **Selections as id anchors** — a `Cursor` is a `CharId` (the gap before
  that character) or `null` (end of document). A `Selection` is an
  anchor/head pair of cursors.
- **Deletion gravitation** — when the anchored character is deleted, the
  cursor resolves to the nearest *surviving* character to its right in
  document order; if there is none, it resolves to the end of the document
  (`TextModel.resolveCursor`).
- **Same-position inserts ordered by op id** — each character remembers the
  id it was inserted after; siblings sharing that position are sorted by
  their insertion `OpId`, so concurrent inserts at the same position
  converge deterministically regardless of arrival order.
- **Deletes are tombstones** — delete ops are idempotent and safe to apply
  before the matching insert arrives.

## Pagination

`PagedTextModel` stores the live sequence in pages of `pageSize`
characters. Rebalancing moves characters between pages but never touches
their ids or node identity, so id-anchored selections are unaffected by
pagination. `locate(id)` reports which page a character lives on.

## Merge & replay

Operations (`insert` / `delete`) carry unique op ids. `mergeOps` unions op
logs (de-duplicated by op id) and `replay` rebuilds a model from a log.
Because document order is *derived* from `(afterId, opId)` and deletes are
tombstones, replaying merged branches in any order converges to the same
text, and selections resolved in the paged model match the unpaginated
model exactly.

## Scripts

```sh
npm test   # type-check + compile with tsc, then run node:test suites
npm run build
```

No runtime or dev dependencies; tests use the built-in `node:test` runner
with minimal ambient declarations in `test/node-types.d.ts`.

## Layout

- `src/model.ts` — core model: ops, `TextModel`, cursors/selections, `Site`, `mergeOps`, `replay`
- `src/paged.ts` — `PagedTextModel` paged storage
- `test/model.test.ts` — deletion gravitation, same-position insert ordering, idempotency
- `test/paged.test.ts` — id stability across page moves, page tiling
- `test/merge.test.ts` — two-branch merge/replay, paged vs unpaginated selection equivalence
