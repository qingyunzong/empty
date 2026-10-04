# protocol

会话协议库（仅使用 Go 标准库）：动作由公开有限状态表授权，状态迁移记录先持久化后返回，
幂等键只能绑定同一动作，过期会话拒绝迁移。

## 设计

- `Table`（table.go）：公开有限状态表，`Transitions[Edge{State, Action}]` 存在即授权，
  值为下一状态。`Interpreter` 是串行表解释器：纯内存、逐条应用动作的参考实现，
  崩溃恢复测试以它为对照基准。
- `Store`（store.go）：仅追加的记录日志。每条记录为 `crc32(json) + " " + json + "\n"`。
  `Append` 先写字节再 `Sync`，返回时记录已持久。打开时重放到第一条不完整/校验失败的
  记录为止，并把设备截断到最后一条有效记录，容忍崩溃留下的撕裂尾部。
- `Machine`（machine.go）：会话状态机。`Apply` 顺序：过期检查 → 幂等键检查
  （同动作重放直接返回记录结果，不写日志；不同动作返回 `ErrIdempotencyConflict`）→
  查表授权 → 持久化迁移记录 → 更新内存状态并返回。会话过期时间写入日志头，
  重启后仍然生效；过期后一切迁移返回 `ErrSessionExpired`。

## 崩溃恢复模型（测试）

`crashDevice` 把 `Append`/`Sync` 计为写点：写先进易失缓冲，`Sync` 才落 durable。
每个场景注入恰好一次崩溃（在 Sync 处崩溃时只冲刷一半字节，模拟撕裂写），随后丢弃
易失缓冲并重启，用相同幂等键重试被中断的步骤，最终对照串行表解释器验证：
最终状态、幂等键绑定、日志迁移序列必须与解释器历史一致。

`TestCrashAtEveryWritePoint`（脚本化，12 个写点）与
`TestCrashAtEveryWritePointRandomScript`（固定种子随机脚本，24 个写点）
对干净执行的每一个写点各崩溃一次并重启验证。

## 测试结果

`go test ./...` 实际输出（Go 1.27.1，linux/amd64）：

```
ok  	protocol	0.010s
```

`go test -race -count=1 ./...` 亦全部通过（13 个顶层用例，含 13+25 个崩溃点子用例）。
