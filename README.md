# dirscan

Scan a directory into a **comparable manifest** of relative paths, entry types
and sha256 content hashes. TypeScript, zero runtime dependencies.

## Behavior

- **Relative paths, types, hashes** — every entry is recorded with its
  POSIX-style path relative to the scanned root, a type
  (`file` / `directory` / `symlink` / `other`) and, for files, a sha256 of
  its contents plus its size.
- **Symlinks are never followed** — entries are discovered with `lstat`;
  a symlink is recorded with its raw `target` only. Directory symlinks are
  not traversed and link targets outside the tree are never read.
- **Instability detection** — each file is `lstat`-ed before and after it is
  read. If the content evidence changed mid-read, the read is retried up to
  `--retries` times (default 3); if it never stabilizes, the entry is marked
  `"unstable": true` and `scan` exits with code 2.
- **Evidence-gated cache** — with `--cache <file>`, a cached hash is reused
  only when the stored evidence (`size`, `mtimeMs`, `ctimeMs`, `ino`) matches
  the current `lstat` exactly. `ctime` is kernel-maintained and cannot be
  forged with `utimes(2)`, so a same-size edit with a restored mtime still
  invalidates the cache: controlled modifications never compare falsely equal.
- **Comparable output** — the manifest is canonical JSON (entries sorted by
  path, fixed key order), so identical trees produce byte-identical files.
  `diff` compares two manifests and reports added/removed/changed entries.

## Usage

```sh
npm run build
node dist/src/cli.js scan <dir> [--cache cache.json] [--retries 3] [--out manifest.json]
node dist/src/cli.js diff manifestA.json manifestB.json
```

Exit codes: `0` ok/identical, `1` manifests differ, `2` unstable entries, `64` usage.

## Tests

```sh
npm test
```

Compiles with `tsc` and runs the suite with the Node built-in test runner.
The suite covers: path/type/hash recording, symlink non-traversal (including
links escaping the tree), deterministic manifests, cache reuse and
invalidation, same-size + restored-mtime edits (no false equality), limited
retries with unstable marking, and the CLI end to end.

## Layout

- `src/scanner.ts` — tree walk, stability-aware hashing, cache evidence check
- `src/cache.ts` — JSON file cache (`JsonHashCache`)
- `src/manifest.ts` — canonical serialization and manifest diffing
- `src/cli.ts` — `scan` / `diff` commands
- `types/node.d.ts` — minimal ambient Node declarations (offline builds)
