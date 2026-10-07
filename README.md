# treewalk

Concurrent directory traversal for Go with a bounded number of open
directory handles, optional symlink following, and cycle detection by
file identity (device + inode) rather than path strings.

## Usage

```go
res := treewalk.Walk(ctx, "/some/dir", treewalk.Options{
    FollowSymlinks: true, // resolve and descend into symlinked dirs
    MaxOpen:        8,    // never more than 8 open dir handles
}, treewalk.OSAdapter{})

for _, e := range res.Entries { /* every visited node */ }
for _, err := range res.Errors  { /* per-path failures, incl. ErrCycle */ }
```

## Guarantees

- **Handle budget**: at most `MaxOpen` directory handles are open at any
  moment (one per worker; each worker closes its handle before moving on).
- **Identity-based cycle detection**: directories are tracked by
  (device, inode), so symlink loops, aliased paths, and bind mounts
  cannot cause infinite traversal; repeats are reported as `ErrCycle`.
- **Per-path errors**: every failure is collected as `Error{Path, Op, Err}`
  and never aborts the rest of the walk.
- **Cancellation**: when the context is canceled, the walk returns
  promptly and every opened handle is closed.
- **Injectable adapter**: the `Adapter` interface (`Lstat`/`Stat`/`Open`)
  lets tests substitute in-memory filesystems; `OSAdapter` backs it with
  the real OS.

## Test

```sh
go test ./...
```
