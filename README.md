# cdc-snapshot-store

Content-defined-chunking snapshot store for numeric-experiment snapshots.
Node.js 22, standard library only, offline single-machine.

## Layout

```
repo/
  chunks/<sha256>     committed content-defined blocks (name = strong hash)
  tmp/<sha256>.tmp    temp blocks being written (cleanable after crash)
  JOURNAL             write-ahead log of the pending version entry
  index.json          committed index (commit point)
  index.json.tmp      staged index, renamed atomically into place
```

- Chunk table entry: `{ sha256, adler32, size }` — Adler32 weak check + SHA256 strong check.
- Chunking: gear-hash CDC (32-byte window), default min/avg/max 2K/8K/64K.
- Global checksum: SHA256 over canonical (path, size, file-sha256) list, covers full content.

## Commit protocol

1. Write temp blocks to `tmp/`, fsync, rename into `chunks/`, fsync dir.
2. Write `JOURNAL`, fsync.
3. Write `index.json.tmp`, fsync, rename to `index.json` (commit point), fsync dir, delete journal.

Crash points (injectable via `writeSnapshot(repo, src, { fault })` or `SNAP_FAULT` env):
`chunk-partial` (block half-written), `journal-uncommitted` (log written, not committed),
`index-no-fsync` (index staged, never fsynced/renamed). After any of these, `resume()`
returns the repo to the last commit point and removes temp blocks; all other operations
fail with `ERR_DIRTY` until then.

## API

`writeSnapshot(repo, srcDir, opts?)` `resume(repo)` `verify(repo, version?)`
`diff(repo, a, b)` (canonical paths, byte-order sorted) `materialize(repo, version, dest)`
(incremental: reads only changed chunks; global checksum verified over full content).

## CLI

```
node cli.js write <repo> <srcDir>
node cli.js resume <repo>
node cli.js verify <repo> [version]
node cli.js diff <repo> <a> <b>
node cli.js materialize <repo> <version> <destDir>
```

Errors are JSON on stderr with codes `ERR_CRASH` / `ERR_CHUNK` / `ERR_VERSION` / `ERR_DIRTY`.

## Tests

`node --test` — see `RESULTS.md` for real output.
