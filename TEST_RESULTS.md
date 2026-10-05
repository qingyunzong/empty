# Test Results

Command: `go test ./...` (GOCACHE=/tmp/gocache, go1.27.1 linux/amd64)

```
ok  	automata	0.024s
```

All 10 tests pass, including the 300-iteration random cross-check of
Compare against brute-force enumeration over {a,b} up to length 7.
