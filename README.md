# testiso

Isolated per-run test directories in Go.

## Behavior

- **Isolated run dir per run**: `RunRoot/<task>/gen-NNNNNN`, created
  atomically; parallel runs of the same task get distinct generations
  (generational isolation).
- **Manifest-only copies**: only files listed in the request manifest
  (or parsed via `LoadManifest`) are copied, staged through `tmp/` and
  renamed into `inputs/`.
- **Escape rejection**: absolute paths, `..` traversal, and symlinks
  resolving outside `SrcRoot` fail with `ErrPathEscapesRoot`.
- **Failure handling**: on failure an evidence log is kept at
  `evidence/failure.log` inside the run dir, while non-evidence temp
  items (`tmp/`) are always removed.
- **Controlled faults**: `ControlledAdapter` wraps any `FileAdapter` to
  inject copy failures for verification.

## Usage

```go
r := &testiso.Runner{SrcRoot: "fixtures", RunRoot: "runs"}
res, err := r.Run(testiso.Request{Task: "smoke", Manifest: []string{"a.txt"}})
```

## Test

```
go test ./...
```
