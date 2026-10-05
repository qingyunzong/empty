# interp

一个小型 Lisp 方言解释器库，仅使用 Go 标准库。包含两个可交叉核对的求值器：

- `Machine`（machine.go）：CEK 式显式栈求值机。
  - 词法闭包、递归、`try/catch/finally`、`throw`。
  - 尾调用不压栈，因此无待执行 `finally` 时尾递归为常量栈空间；有待执行 `finally` 时清理帧必须保留，栈随递归增长（`TestFinallyPreventsTailCallElimination` 验证）。
  - `Run(budget)` 按步数预算执行；预算耗尽返回 `StatusSuspended`，机器状态完整保留，可继续 `Run`。
  - `Snapshot()`/`Restore()` 用 gob 序列化整个继续执行状态（控制、环境、续延栈、异常处理器、日志）。环境与闭包之间存在循环引用（递归函数捕获绑定自身的全局环境），因此序列化时把 `*Env`/`*Closure` 内联为 ID 表。
- `Ref`（ref.go）：朴素递归参考解释器，不做尾调用消除（每次调用都增长 Go 调用栈），与 `Machine` 共享语法、值与内建函数。

测试（interp_test.go）对同一批程序在两个求值器上核对最终值与 `emit` 清理日志，并验证：

- 闭包/词法作用域、递归、序对与引用；
- 尾调用栈有界（20 万次循环 `MaxStack <= 64`），参考解释器同程序栈深随递归线性增长；
- `finally` 存在时尾调用不消除栈，清理按由内向外顺序执行；
- 异常展开顺序：内层 `finally` → `catch` → 外层 `finally`；`finally`/`catch` 中再抛异常会取代原异常；
- 未捕获异常仍执行沿途 `finally` 后报错；
- 小步数预算反复挂起/恢复、以及每步快照-恢复后继续执行，结果与不中断运行及参考解释器一致。

运行测试并查看记录：`go test ./...`，结果见 TEST_RESULTS.md。
