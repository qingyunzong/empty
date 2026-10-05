# interp — 可挂起、可序列化的小语言解释器

仅用 Go 标准库实现。语言为 S 表达式,支持词法闭包、递归(`letrec` /
命名 lambda)、异常(`throw` / `catch`)与 `finally`。

## 结构

- `ast.go` — 单一结构体 AST(`Node`),天然可 JSON 序列化。
- `parse.go` — S 表达式解析器;`let`/`letrec` 在解析期脱糖为 lambda 调用。
- `value.go` — 值、闭包、词法环境链、原语(`+ - * / = < > not log`)。
- `machine.go` — CESK 风格显式栈状态机(被测实现)。
- `serialize.go` — 整机状态 JSON 序列化(环境/闭包图用 ID 表编码,
  正确处理递归闭包造成的 env↔closure 循环)。
- `reference.go` — 不消尾调用的递归树遍历参考解释器(语义基准)。
- `interp_test.go` — 测试,机器与参考解释器交叉核对值和清理日志。

## 关键语义

- **尾调用消除**:调用发生时若显式栈顶是函数边界帧(或栈空),复用该
  边界,栈不增长;若栈顶存在待执行的 `finally`/`catch` 帧,则必须保留
  现场(它们要观察被调者的返回或异常),压入新边界帧。
  `TestTailCallElimination` 验证 10 万次尾递归 `MaxDepth ≤ 50`;
  `TestTailCallBlockedByFinally` 验证有 pending finally 时栈随深度增长
  且清理日志顺序与参考解释器一致。
- **步数预算**:`Machine.Steps` 每迁移一步减一,耗尽时以
  `Status == Suspended` 停机,完整状态(控制、环境、续延栈、日志)
  原样保留,`Resume` 补充预算后继续。
- **可序列化继续执行**:`Machine` 实现 `MarshalJSON`/`UnmarshalJSON`。
  测试在每一步之后都做一次 JSON 往返再续跑,结果与日志和不间断运行、
  参考解释器完全一致。
- **清理日志**:`log` 原语追加到 `Machine.Log` / `Ref.Log`,
  `finally` 的执行顺序(正常返回与异常展开两条路径)据此核对。

## 测试结果(实际运行记录,go1.27.1 linux/amd64)

```
$ go test -v ./...
=== RUN   TestClosures
--- PASS: TestClosures (0.01s)
=== RUN   TestRecursion
--- PASS: TestRecursion (3.86s)
=== RUN   TestExceptionsAndFinally
--- PASS: TestExceptionsAndFinally (0.01s)
=== RUN   TestTailCallElimination
--- PASS: TestTailCallElimination (1.38s)
=== RUN   TestNonTailRecursionGrowsStack
--- PASS: TestNonTailRecursionGrowsStack (0.01s)
=== RUN   TestTailCallBlockedByFinally
--- PASS: TestTailCallBlockedByFinally (0.01s)
=== RUN   TestStepBudgetExhaustionPreservesState
--- PASS: TestStepBudgetExhaustionPreservesState (0.00s)
=== RUN   TestSerializableContinuation
--- PASS: TestSerializableContinuation (0.21s)
=== RUN   TestSerializedClosureKeepsRecursion
--- PASS: TestSerializedClosureKeepsRecursion (0.00s)
=== RUN   TestCrossCheckPrograms
--- PASS: TestCrossCheckPrograms (0.03s)
PASS
ok  	interp	5.545s
```

`go vet ./...` 与 `gofmt -l .` 均无输出。
