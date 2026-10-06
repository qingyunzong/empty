# archive-dir-index

Archive directory index for the browser importer. Entries are addressed by
slash-segmented paths; the index normalizes paths, expands symlinks, and
rejects invalid packages atomically.

## Rules

- **Segmentation**: paths split on `/`; empty segments and `.` are dropped.
- **Dot-dot elimination**: `..` pops the previous segment; popping past the
  archive root rejects the path (`ESCAPE_ROOT`). Leading `/` means "from the
  archive root". Everything is case-sensitive: `A` and `a` are different names.
- **Duplicates**: two entries whose paths normalize to the same string reject
  the whole package (`DUPLICATE_PATH`). Non-directories with children (in
  either insertion order) reject with `TYPE_CONFLICT`.
- **Symlinks**: a symlink's target is normalized once (relative to the
  symlink's parent directory, or from the root when absolute) and substituted
  wherever the symlink appears during resolution. Cycles throw
  `SYMLINK_CYCLE` carrying the **shortest repeated chain** of normalized
  symlink paths in `error.chain` (e.g. `a -> b -> c -> b` reports `['b', 'c']`).
- **Slow model**: `src/slowModel.ts` is a deliberately naive recursive
  reference implementation; `test/crosscheck.test.ts` verifies the optimized
  index against it on thousands of generated archives.

## API

```ts
import { buildIndex, ArchiveError } from 'archive-dir-index';

const index = buildIndex([
  { path: 'dir/real.txt', type: 'file' },
  { path: 'link', type: 'symlink', target: 'dir' },
]);

index.resolve('link/./real.txt'); // { path: 'dir/real.txt', type: 'file', ... }
index.resolve('../x');              // throws ArchiveError { code: 'ESCAPE_ROOT' }
```

Error codes: `ESCAPE_ROOT`, `EMPTY_PATH`, `DUPLICATE_PATH`, `TYPE_CONFLICT`,
`MISSING_TARGET`, `SYMLINK_CYCLE`, `NOT_FOUND`.

## Test

```sh
npm test   # compiles with tsc and runs node --test on the compiled suites
```

Requires a `tsc` on PATH (TypeScript 5+/7) and Node.js 18+.
