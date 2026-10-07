# runtool

Isolated per-run directories for test tooling.

## Behavior

- **Isolated run dirs**: every `Runner.Start(task)` claims a fresh
  `<root>/<task>/gen-NNNNNN` directory. Parallel runs of the same task name
  are separated by generation via atomic `Mkdir`.
- **Manifest-only staging**: `Run.StageInputs(srcRoot, manifest)` copies only
  the listed entries into `inputs/`. Absolute paths, `..` escapes, and
  symlinks resolving outside `srcRoot` are rejected (including symlinks
  nested inside copied directories).
- **Failure handling**: `Run.Finish(err)` preserves `evidence/` (and writes a
  `FAILURE.txt` marker with the cause) while removing non-evidence
  temporaries under `work/`. On success the whole run dir is removed.
- **Controlled FS adapter**: all filesystem access goes through the `FS`
  interface, so tests can wrap `OSFS` to inject copy failures and verify
  evidence retention and cleanup.

## Usage

```go
runner, _ := runtool.NewRunner("/tmp/runs", nil)
run, _ := runner.Start("my-task")
if err := run.StageInputs("/path/to/inputs", []string{"config.yaml", "data"}); err != nil {
    run.Finish(err)
    return err
}
err := doWork(run)
run.Finish(err) // keeps evidence/ on failure, removes everything on success
```

## Test

```sh
go test ./...
```
