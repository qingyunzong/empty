# pcheck — 有界协议安全性检查库

仅依赖 Go 标准库。

## 模型

- 协议由**节点状态表**描述：`Table` = 当前状态 → 消息种类 → 迁移（下一状态 + 发出的消息）。
- 初始**种子消息至多 12 条**（`MaxSeedMessages`），在途消息总量受 `MaxInFlight` 约束（默认 12）。
- 每一步**只能交付当前已发送（在途）的消息**；表中未定义的（状态, 种类）组合视为丢弃消息。

## 枚举的故障与调度

- **重排**：每一步可交付任意一条在途消息（BFS 覆盖全部交付顺序）。
- **重复一次**：整条执行至多一次，让一条在途消息在不移除的情况下多交付一份。
- **一次崩溃**：整条执行至多一个节点崩溃，崩溃节点不再接收消息。

## 结论

`Check` 返回三种结论，把“未闭合预算”与“无反例”明确区分：

- `Unsafe`：发现安全反例，`Result.Trace` 为 **BFS 最短** 反例轨迹；
- `Safe`：状态空间闭合，无反例；
- `Unknown`：预算（`Budget.MaxDepth` / `Budget.MaxStates`）耗尽而空间未闭合。

## 证书回放

`Replay(p, trace)` 独立回放反例轨迹并验收：逐步检查合法性（在途下标、
重复/崩溃预算、崩溃节点不可交付、容量约束），并要求回放结束确实违反
`Invariant`；任一不满足即拒绝并说明原因。

## 示例

```go
res, err := pcheck.Check(protocol, pcheck.Budget{MaxStates: 100000})
if res.Verdict == pcheck.Unsafe {
    // res.Trace 为最短反例，可交给 Replay 验收
    err = pcheck.Replay(protocol, res.Trace)
}
```

## 验证

`go test ./...` 实际结果（go1.27.1 linux/amd64）：

```
ok  	pcheck	0.051s
```
