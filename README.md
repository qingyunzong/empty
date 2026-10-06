# join-pager

Two-table inner join with duplicate keys, deterministic ordering, and
version-bound keyset pagination. TypeScript, no runtime dependencies.

## Semantics

- **Inner join** on key equality. `NULL` keys never match — not even
  `NULL = NULL` (SQL semantics).
- **Order**: results sort by `(key, leftId, rightId)`. Numbers sort before
  strings, each by value, so the order is total and deterministic even with
  duplicate keys.
- **Cursor**: pins the versions of *both* tables plus the last emitted
  `(key, leftId, rightId)` triple. The next page resumes strictly after
  that triple.
- **Staleness**: every table mutation bumps its version. If either table
  changed since the cursor was issued, `joinQuery` throws
  `StaleCursorError` — old pagination can never be mixed with new table
  contents.

## API

```ts
import { Table, joinQuery, fullJoin, StaleCursorError } from "./src/join.js";

const left = new Table();
const right = new Table();
left.insert({ id: 1, key: "a" });
right.insert({ id: 10, key: "a" });

const page1 = joinQuery(left, right, { limit: 100 });
const page2 = joinQuery(left, right, { limit: 100, cursor: page1.cursor! });
// page.cursor === null  -> result exhausted
```

`fullJoin(leftRows, rightRows)` is the sorted full-join reference used by
the tests to verify pagination.

## Test

```sh
npm test   # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

Tests cover duplicate-key cross products, null handling, key ordering,
page-concatenation vs. the snapshot full-join reference, stale-cursor
rejection on insert/update/delete of either table, and a seeded randomized
suite interleaving mutations with paginated reads.
