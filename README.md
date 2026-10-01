# syncmap

Local two-directory diff/apply tool. Python 3.11+ standard library only.

## Model

- Files are split into 64 KiB blocks; each block gets a weak `adler32`
  and a strong `sha256` checksum.
- `.manifest` (JSON) records per file: POSIX relative UTF-8 path, size,
  `mtime_ns`, and the block table. Empty files have zero blocks.
- `diff(src, dst)` emits ops to turn `dst` into `src`:
  - `ADD <path>` — only in source
  - `DEL <path>` — only in target
  - `MOD <path> <i,j,...>` — content differs; only changed block numbers
    are listed. A target block is changed when no source block matches it
    (weak adler32 first, then strong sha256 confirmation — an adler32
    collision alone never matches); source blocks beyond the target
    file's length are also listed.
- Block matching tie-break: among source blocks with equal strong
  checksum, the lexicographically smallest path wins, then the smallest
  block index (`syncmap.find_block_match`).
- Paths must be POSIX relative UTF-8; absolute paths or paths escaping
  via `..` raise `PathError`.
- `apply` uses only the manifest and the source directory. All source
  data is verified against the manifest and staged in a temporary
  directory inside the target first; files are then committed with
  atomic `os.replace`. Any failure before the commit phase leaves the
  target untouched.

## CLI

```sh
python -m syncmap manifest DIR              # write DIR/.manifest
python -m syncmap diff SRC_DIR DST_DIR      # human-readable ops
python -m syncmap diff SRC_DIR DST_DIR --json
python -m syncmap apply MANIFEST SRC_DIR DST_DIR
```

## Tests

```sh
python -m unittest discover -s tests -v
```
