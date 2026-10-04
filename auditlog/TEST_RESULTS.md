# Test Results

## `go test ./...`

Executed 2026-10-05 in the task sandbox:

```
$ go test ./...
/bin/bash: line 1: go: command not found
exit code: 127
```

The Go toolchain is **not available in this environment**: no `go`/`gccgo`
binary anywhere on disk, no root privileges for `apt-get`, and no network
access (DNS resolution fails), so the toolchain could not be installed.
The Go test suite therefore could not be executed here. On any machine with
Go >= 1.21, run:

```
cd auditlog
go test ./...        # or: go test -v ./...
```

## Design-level validation actually performed

The acceptance properties were validated with a byte-exact Python
re-implementation (`/tmp/sim.py`, same frame layout, same CRC-32/IEEE, same
scan/recover semantics as `frame.go`/`logfile.go`):

```
OK: 151 truncation cases, 150 corruption cases, dup-seq checks passed
```

- Byte-by-byte truncation: for every cut offset 0..len(log), recovery
  succeeds and leaves exactly the valid frame prefix (151 cases).
- Single-byte corruption: for every byte position, flipping it makes
  recovery report corruption and leave the file byte-for-byte unmodified
  (150 cases).
- Index rebuild rejects duplicate sequence numbers with different content
  and tolerates identical duplicates.

This simulation validates the algorithm, not the Go code itself; the Go
tests in `auditlog_test.go` encode the same properties and must be run
where a Go toolchain exists.
