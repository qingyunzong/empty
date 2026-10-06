# archive-index

Archive directory index for the browser importer. TypeScript, zero runtime
dependencies.

## Semantics

- **Slash-segmented paths.** `normalizePath` drops empty and `.` segments and
  resolves `..` against the accumulated segments.
- **Root escape rejected.** If dot-segment elimination would climb above the
  archive root, a `PathEscapeError` is thrown and the whole archive is
  rejected.
- **Case-sensitive.** Paths are never case-folded; `Readme` and `readme`
  coexist.
- **Duplicates reject the whole archive.** Two entries that normalize to the
  same path throw `DuplicatePathError` from `buildIndex`; no partial index is
  produced.
- **Symlinks expand via normalized targets.** Targets starting with `/` are
  resolved against the archive root, others against the link's parent
  directory; the normalized target is then expanded through the index.
- **Cycles return the shortest repeated chain.** `resolve` returns
  `{ ok: false, cycle }` where `cycle` is the minimal repeating sequence of
  link paths (e.g. `a -> x -> y -> z -> y` yields `['y', 'z']`).

## API

```ts
import { buildIndex, normalizePath } from 'archive-index';

const index = buildIndex([
  { path: 'dir/link', type: 'symlink', target: '../sibling.txt' },
  { path: 'sibling.txt', type: 'file' },
]);

index.get('dir//link');        // { type: 'symlink', path: 'dir/link', target: 'sibling.txt' }
index.resolve('dir/link');     // { ok: true, path: 'sibling.txt' }
```

Errors: `PathEscapeError`, `DuplicatePathError`, `InvalidEntryError`
(all extend `ArchiveIndexError`).

## Verification

`src/slow.ts` is a deliberately naive recursive reference model of the same
semantics. `test/differential.test.ts` generates random archives (dot
segments, root escapes, case collisions, duplicate normalized paths, symlink
chains and cycles) and asserts the fast implementation and the slow model
agree on every outcome, including identical cycle chains.

## Test

```sh
npm test   # tsc -p tsconfig.json && node --test "dist/test/*.test.js"
```
