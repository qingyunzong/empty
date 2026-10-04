# mcheck

`mcheck` 是一个仅依赖 Go 标准库的显式状态模型检查库，用于验证消息传递协议的安全性。

## 模型

- `Spec.Nodes`：各节点初始状态；`Spec.Table`：节点状态表，`Table[节点状态][消息类型] -> Effect{下一状态, 发送消息}`。
- `Spec.Inbox`：初始在途消息，至多 12 条（`MaxMessages`），超出则 `Check` 报错。
- 每步只能交付当前已发送（在途）的消息；节点处理消息后可发送新消息，新消息随后才可交付。
- 可选故障枚举（各至多一次）：`AllowDup` 重复交付一条在途消息；`AllowCrash` 使一个节点崩溃。

## 结果

`Check` 以广度优先搜索返回最短安全性反例：

- `Violation`：找到反例，`Result.Trace` 为最短事件序列（deliver / duplicate / crash）。
- `Safe`：状态空间在预算内完全闭合，无反例。
- `BudgetExhausted`：`MaxDepth`/`MaxStates` 预算在闭合前耗尽，与“无反例”严格区分，不作安全性结论。

## 回放证书

`Replay(spec, trace)` 确定性重放轨迹并校验每步合法性（消息须在途、重复/崩溃须受预算约束），
逐步检查安全性；`ReplayResult.Accepts()` 为真表示该轨迹是可验收的安全性反例证书。
`Check` 返回的反例均可通过回放验收。

## 实测结果

```
$ go test ./...
ok  	mcheck	0.004s
```

10 个测试全部通过，覆盖：重排反例及最短性、重复交付、节点崩溃、预算未闭合与
Safe 的区分、状态数预算、非法轨迹拒绝、输入校验（>12 条消息等）、初始状态违例、
发送消息后方可交付。
