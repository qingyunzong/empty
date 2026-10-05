# plan — 计划执行库

仅使用 Go 标准库。

## 语义

- 每个 `Step` 携带前置检查 `Pre`、产生后像的正向动作 `Apply`、逆动作 `Undo`（plan.go）。
- `Execute` 顺序执行；任一前置或正向动作失败时，对已应用步骤**按逆序回滚**。
- 逆动作失败不中断其余回滚；未能回滚的步骤记入 `Result.Pending`（待恢复尾部，
  按计划顺序），首个逆动作错误记入 `Result.UndoErr`，作为未完成的证据。
- 所有写操作经 `Store.CAS` 比较并交换：当前值与预期前置/后像不符时返回
  `ErrConflict` 且不做任何修改——未知外部修改不会被强行覆盖。

## 组件

- `MemStore`：内存 KV，CAS 语义（store.go）。
- `FakeStore`：包装 `MemStore`，`FailAt(n)` 在第 n 次变更调用注入一次性
  `ErrInjected`，用于故障穷举（fake.go）。
- `SetStep` / `CreateStep` / `DeleteStep`：构造前后像与逆动作完备的步骤。

## 测试（plan_test.go）

- 成功路径、前置失败回滚、创建/删除步骤。
- 外部修改在执行前、执行中（绕过 Pre 由 CAS 拦截）、回滚前三种时机均不被覆盖；
  回滚遇外部修改时留下 Pending 尾部且外部值原样保留。
- 故障穷举：4 步计划的所有单故障注入点（9 个）、3 步计划的所有双故障组合
  （15 组）。每种情形核对通用不变式：存储 == 初始状态 + 恰好 Pending 尾部步骤
  的后像——要么全恢复，要么有证据表明哪些未完成。

## 实测结果

```
$ go test ./...
ok  	plan	0.031s
```

（`go vet ./...` 与 `gofmt -l .` 均无输出。）
