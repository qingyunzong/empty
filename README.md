# dirwalk

Concurrent directory-tree walker for Go with a bounded open-handle
budget, identity-based symlink-cycle detection, per-path error
collection, and prompt cancellation.

## Features

- **Async traversal** of real directories: each discovered directory is
  walked in its own goroutine.
- **Optional symlink following** (`Options.FollowSymlinks`). Cycles are
  detected by file identity (device + inode), not by path, so symlink
  loops and bind-mount loops terminate, and each underlying directory is
  traversed at most once no matter how many paths reach it.
- **Bounded handles**: at most `Options.MaxOpen` directory handles are
  open at any instant (semaphore); the budget slot is released only
  after the handle is closed.
- **Per-path errors**: failures are collected in `Result.Errors[path]`
  and the walk continues elsewhere.
- **Cancellation**: canceling the context stops in-flight reads, closes
  every open handle, and returns the context error with partial results.
- **Injectable `Adapter`** filesystem interface: `OSFS` for the real
  filesystem, fakes for tests (see `fakefs_test.go`, which verifies
  link cycles and budget conservation).

## Usage

```go
res, err := dirwalk.Walk(ctx, dirwalk.OSFS{}, "/some/dir", dirwalk.Options{
    FollowSymlinks: true,
    MaxOpen:        16,
})
for _, r := range res.Entries {
    fmt.Println(r.Type, r.Path)
}
for path, perr := range res.Errors {
    log.Printf("%s: %v", path, perr)
}
```

## Test

```sh
go test ./...
```
