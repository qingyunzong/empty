# Test Results

Command: `go test ./...`
Date: 2026-10-05

Actual output:

```
/bin/bash: line 1: go: command not found
```

Exit code: 127

The Go toolchain is not installed in this environment and cannot be
installed: outbound network access is blocked (DNS resolution fails, no
proxy reachable) and no Go distribution exists on the local filesystem
or mounted Windows drives. The tests could therefore not be executed
here. The package uses only the Go standard library; run `go test ./...`
in any environment with Go 1.22+ to execute the suite.
