# Test Results

Date: 2026-10-06 21:12:38 CST
Go: go version go1.27.1 linux/amd64

## `go test ./...`

```
ok  	objstore	0.046s
```

## `go test -race -count=1 ./...`

```
ok  	objstore	1.069s
```

## `go test -count=1 -v ./...` (test list)

```
--- PASS: TestGCCollectsUnreachableOnly (0.00s)
--- PASS: TestGCNewRootDuringMark (0.00s)
--- PASS: TestGCNewRootBeforeDelete (0.00s)
--- PASS: TestGCRootReplacementDuringScan (0.00s)
--- PASS: TestGCTempUploadLeases (0.00s)
--- PASS: TestGCConcurrentRootAdditions (0.04s)
--- PASS: TestCrashDuringGC (0.00s)
--- PASS: TestGCRejectsConcurrentCycles (0.00s)
--- PASS: TestPutGetBlobAndTree (0.00s)
--- PASS: TestPutTreeRejectsMissingRefs (0.00s)
--- PASS: TestAddRootRejectsMissingObject (0.00s)
--- PASS: TestRootsPersistAcrossReopen (0.00s)
--- PASS: TestCrashDuringStatePersist (0.00s)
--- PASS: TestLeaseExpiryUsesClock (0.00s)
--- PASS: TestEvidenceLogPersists (0.00s)
--- PASS: TestListObjectsSkipsTmp (0.00s)
--- PASS: TestConcurrentPuts (0.00s)
PASS
ok  	objstore	0.046s
```
