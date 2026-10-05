# planexec

计划执行库（仅 Go 标准库）。每个步骤携带前置条件、后像检查和逆动作。

## 语义

- `Step{Pre, Do, Image, Undo}`：前置条件 → 正向动作 → 后像检查 → 逆动作。
- `Execute` 顺序执行；任一步前置或动作失败即中止批处理。
- 已应用步骤按**逆序**回滚。
- 回滚时先核对后像：不匹配视为**未知外部修改**，不强行覆盖，记录
  `Conflict` 并停止，剩余未恢复尾部进入 `Result.Pending`。
- 逆动作失败同样停止回滚，未恢复尾部进入 `Result.Pending`。
- `SavePendingTailFile` / `LoadPendingTailFile` 将待恢复尾部以 JSON
  持久化/读取，作为未完成恢复的证据。

## 测试

`FakeStore` 支持按调用序号注入确定性故障。`TestExhaustiveFaultInjection`
对失败批处理的每一个存储调用序号穷举注入故障，核对不变量：要么存储
完全恢复到初始状态，要么结果携带可持久化的未完成证据（非空 Pending
尾部及其原因）。实际结果见 `test-results.md`。
