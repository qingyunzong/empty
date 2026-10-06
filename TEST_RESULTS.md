# 测试结果记录

日期: 2026-10-06 10:37:56 CST
Go 版本: go version go1.27.1 linux/amd64

## 命令: go test ./...

```
ok  	txcache	0.291s
```

## 命令: go test -race -count=1 ./...

```
ok  	txcache	5.799s
```

## 详细输出 (go test -v ./...)

```
=== RUN   TestCommitInvalidatesHandles
--- PASS: TestCommitInvalidatesHandles (0.00s)
=== RUN   TestRollbackInvalidatesHandles
--- PASS: TestRollbackInvalidatesHandles (0.00s)
=== RUN   TestGenerationBindingAcrossTransactions
--- PASS: TestGenerationBindingAcrossTransactions (0.00s)
=== RUN   TestNestedSavepointRollback
--- PASS: TestNestedSavepointRollback (0.00s)
=== RUN   TestIDReuseCannotResurrectHandle
--- PASS: TestIDReuseCannotResurrectHandle (0.00s)
=== RUN   TestClosedTransactionRejectsOps
--- PASS: TestClosedTransactionRejectsOps (0.00s)
=== RUN   TestBadSavepoint
--- PASS: TestBadSavepoint (0.01s)
=== RUN   TestDeleteSemantics
--- PASS: TestDeleteSemantics (0.00s)
=== RUN   TestRandomOpsMatchModel
=== RUN   TestRandomOpsMatchModel/seed=1
    model_test.go:107: completed 4000 random ops: 528 txns, 685 handles, 5 committed keys
=== RUN   TestRandomOpsMatchModel/seed=7
    model_test.go:107: completed 4000 random ops: 487 txns, 697 handles, 5 committed keys
=== RUN   TestRandomOpsMatchModel/seed=42
    model_test.go:107: completed 4000 random ops: 456 txns, 762 handles, 5 committed keys
=== RUN   TestRandomOpsMatchModel/seed=1337
    model_test.go:107: completed 4000 random ops: 454 txns, 721 handles, 6 committed keys
=== RUN   TestRandomOpsMatchModel/seed=20261006
    model_test.go:107: completed 4000 random ops: 517 txns, 718 handles, 7 committed keys
--- PASS: TestRandomOpsMatchModel (0.64s)
PASS
ok  	txcache	0.706s
```
