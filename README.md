# versioned-join

TypeScript library for inner-joining two mutable tables with duplicate keys,
with deterministic ordering and version-pinned cursor pagination.

## Semantics

- **Join**: `joinPage(left, right, { limit, cursor? })` returns triples
  `{ key, leftId, rightId }` for every matching pair, including the full
  cartesian product of duplicate keys.
- **Ordering**: results are totally ordered by `(key, leftId, rightId)`;
  numeric keys sort numerically and before string keys.
- **Nulls**: rows with a `null` key never match anything, not even other
  nulls.
- **Cursor**: an opaque token pinning both tables (identity token + version)
  and the last emitted triple. Resuming after either table was mutated —
  or against different table instances — throws `StaleCursorError`, so pages
  from different table generations can never be mixed.

## Usage

```ts
import { Table, joinPage } from "./src/join";

const left = new Table([{ key: "a" }, { key: "a" }, { key: null }]);
const right = new Table([{ key: "a" }]);

let cursor: string | undefined;
do {
  const page = joinPage(left, right, { limit: 100, cursor });
  consume(page.rows);
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);
```

## Tests

```sh
npm test
```

Compiles with `tsc` and runs `node --test`. The suite covers duplicate-key
cartesian products, null handling, ordering, cursor resume/staleness, and
randomized mutation runs where paginated output is verified against a
snapshot full-join reference (`fullJoin` over frozen snapshots).
