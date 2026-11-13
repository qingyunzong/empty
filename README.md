# 无限滚动结束证明

采集编排器需要可导入的 Go 无限滚动判定库，接收每轮 DOM 键集合、网络增量、scroll extent 与 sentinel 状态。只有连续观察满足不变条件且无在途请求才结束；内容回收或键复用触发不确定状态。输出每次继续、停止或失败所依据的证据。

## 用法

库代码位于 `infscroll` 包（`example.org/dataeng/q0055/infscroll`）：

```go
d := infscroll.New(infscroll.Config{StableRounds: 3})
v := d.Observe(infscroll.Observation{
    Keys:            domKeys,      // 本轮 DOM 稳定键集合
    NetworkDelta:    newRequests,  // 本轮新增请求数
    InFlight:        inFlight,     // 在途请求数
    ScrollExtent:    scrollHeight, // 滚动 extent
    SentinelVisible: sentinelHit,  // sentinel 是否可见
})
// v.Decision: DecisionContinue / DecisionStop / DecisionIndeterminate
// v.Evidence: 每条不变条件的通过情况、测量值与判定理由
```

- 仅当连续 `StableRounds` 轮满足全部不变条件（无新键、extent 稳定、网络静默、无在途请求、sentinel 空闲）才输出 `DecisionStop`。
- 键消失（内容回收）或退役键复现 / 单轮内重复键（键复用）输出 `DecisionIndeterminate`，终态判定不可逆。
- 运行测试：`go test ./...`
