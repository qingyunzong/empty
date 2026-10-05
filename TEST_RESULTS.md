# 测试结果（go test ./...）

日期: 2026-10-05 11:44:24 CST  Go: go version go1.27.1 linux/amd64

```
=== RUN   TestClosuresAndLexicalScope
--- PASS: TestClosuresAndLexicalScope (0.00s)
=== RUN   TestRecursion
--- PASS: TestRecursion (0.00s)
=== RUN   TestLetLambdaPairs
--- PASS: TestLetLambdaPairs (0.00s)
=== RUN   TestTailCallEliminationBoundedStack
--- PASS: TestTailCallEliminationBoundedStack (0.51s)
=== RUN   TestFinallyPreventsTailCallElimination
--- PASS: TestFinallyPreventsTailCallElimination (0.00s)
=== RUN   TestExceptionOrderCatchThenFinally
--- PASS: TestExceptionOrderCatchThenFinally (0.00s)
=== RUN   TestCatchValue
--- PASS: TestCatchValue (0.00s)
=== RUN   TestThrowThroughMultipleFinally
--- PASS: TestThrowThroughMultipleFinally (0.00s)
=== RUN   TestUncaughtExceptionStillRunsFinally
--- PASS: TestUncaughtExceptionStillRunsFinally (0.00s)
=== RUN   TestThrowInsideFinallyAndCatch
--- PASS: TestThrowInsideFinallyAndCatch (0.00s)
=== RUN   TestBudgetExhaustionPreservesState
--- PASS: TestBudgetExhaustionPreservesState (0.00s)
=== RUN   TestSerializableContinuation
=== RUN   TestSerializableContinuation/(define_(countdown_n)
=== RUN   TestSerializableContinuation/(define_(loop_n)
=== RUN   TestSerializableContinuation/(define_(f_n)
--- PASS: TestSerializableContinuation (0.12s)
    --- PASS: TestSerializableContinuation/(define_(countdown_n) (0.06s)
    --- PASS: TestSerializableContinuation/(define_(loop_n) (0.04s)
    --- PASS: TestSerializableContinuation/(define_(f_n) (0.02s)
=== RUN   TestSnapshotMidProgramIsUsable
--- PASS: TestSnapshotMidProgramIsUsable (0.01s)
=== RUN   TestRuntimeErrors
--- PASS: TestRuntimeErrors (0.00s)
PASS
ok  	interp	0.649s
```
