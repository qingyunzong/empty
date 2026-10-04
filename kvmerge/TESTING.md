# Test Record

Command: `go test ./...`

Actual result in this environment (2026-10-05):

```
/bin/bash: line 1: go: command not found
exit=127
```

The Go toolchain is not installed in this container. Installation attempts
failed because outbound network access is restricted
(`curl https://dl.google.com/go/...` -> connection failed,
`apt-get download golang-go` -> Ign archive.ubuntu.com) and there is no
root access for `apt-get install`.

To verify locally, run:

```
go test ./...        # deterministic + randomized tests
go test -run TestRandomLayeredMatchesModel -v ./...
```

The randomized test compares the merged segment against an uncompressed
read model (Model in model.go) for every registered snapshot reader
sequence and every key, across 25 seeds, plus a second-generation merge
with all readers gone.
