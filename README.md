# Rotating log writer

`formal.Writer` is an `io.WriteCloser` for applications that need bounded log
files. It rotates on byte size and segment age, optionally gzips rotated
files, keeps only the newest configured number of backups, and enforces a hard
total-byte budget.

```go
w, err := formal.NewWriter(formal.Config{
    Dir:           "/var/log/myapp",
    BaseName:      "app.log",
    MaxSize:       64 << 20,
    MaxAge:        24 * time.Hour,
    MaxBackups:    7,
    Compress:      true,
    MaxTotalBytes: 1 << 30,
})
if err != nil {
    return err
}
defer w.Close()

if _, err := w.Write(line); err != nil {
    // errors.Is(err, formal.ErrDiskFull) means existing logs were preserved.
}
```

## Boundary semantics

- `MaxSize` is a capacity: total bytes may be exactly `MaxSize`. The next
  non-empty write rotates first. A single oversized write is accepted into an
  empty file so the writer cannot spin forever.
- `MaxAge` uses a half-open interval: writes before the boundary stay in the
  segment, and a write at exactly `MaxAge` rotates first. Rotation is checked
  when data is written; empty writes and empty segments never rotate.
- `MaxBackups` counts rotated files only. The active file is always retained.
  Zero keeps no rotated files.
- `MaxTotalBytes` covers the active file and every retained backup. The writer
  never truncates, recycles, or overwrites an old log to make room. A write
  that still cannot fit after rotation, compression, and count retention fails
  with `ErrDiskFull`.

## Compression and accounting

A rotated file is renamed to a sequence-numbered name. Compression writes a
complete temporary gzip file and renames it into place before deleting the raw
source. If compression fails or would exceed the byte budget, the raw file is
kept. Retention then removes the oldest sequence numbers, subtracting exactly
the on-disk bytes of each removed file. `Stats.Usage` is therefore exactly the
sum of the sizes of the active file and retained backups.

## Verification

`writer_test.go` checks every event sequence of length four from four event
alphabets (size only, age only, combined compressed, and compressed with a
byte budget), and also runs 100 deterministic 40-event sequences. After every
event it compares the real directory against a naive file-table model: ordered
retention set, decompressed contents, per-file on-disk sizes, and total usage.
