# 实际测试结果

环境：go1.27.1 linux/amd64，仅标准库。日期：2026-10-05。

## `go test ./... -count=1`

```
?   	storecli/cmd/storecli	[no test files]
ok  	storecli/internal/store	0.017s
```

## `go test ./internal/store/ -count=1 -v`（13 个测试全部 PASS）

```
--- PASS: TestCrashRecoveryMatrix (0.01s)   # 5 个掉电注入边界子测试全过
    --- PASS: TestCrashRecoveryMatrix/BeforeCopy
    --- PASS: TestCrashRecoveryMatrix/AfterCopy
    --- PASS: TestCrashRecoveryMatrix/AfterIndexFlush
    --- PASS: TestCrashRecoveryMatrix/AfterCommit
    --- PASS: TestCrashRecoveryMatrix/DuringRetire
--- PASS: TestCompactReclaimsGarbage (0.00s)
--- PASS: TestRecoveryCleansUncommittedGarbage (0.00s)
--- PASS: TestPutGetRoundTrip (0.00s)
--- PASS: TestOverwriteKeepsLatest (0.00s)
--- PASS: TestPersistenceAcrossReopen (0.00s)
--- PASS: TestGetMissingPage (0.00s)
--- PASS: TestStableIDResolutionAcrossGenerations (0.00s)
--- PASS: TestVerifyCleanStore (0.00s)
--- PASS: TestVerifyDetectsCorruptPage (0.00s)
--- PASS: TestVerifyDetectsOrphanSegment (0.00s)
--- PASS: TestVerifyDetectsMissingSegment (0.00s)
--- PASS: TestVerifyDetectsStrayFiles (0.00s)
PASS
ok  	storecli/internal/store	0.020s
```

## `go test ./... -count=1 -race`

```
?   	storecli/cmd/storecli	[no test files]
ok  	storecli/internal/store	1.076s
```

## `go vet ./...`

通过，无输出。

## CLI 冒烟（实际输出）

```
$ storecli put -dir D -id 2 -data world ; storecli put -dir D -id 2 -data WORLD
$ storecli get -dir D -id 2
WORLD
$ storecli compact -dir D
compacted: generation=1 pages=2
$ storecli verify -dir D
generation=1 pages=2 status=OK
$ ls D
COMMIT  idx-000001.log  seg-000004.dat
```
