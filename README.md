# 轨迹点地图匹配候选

位置数据管线需要可导入的 Go 地图匹配状态库，调用方提供候选路段、转移距离和观测误差。用有界 Viterbi 窗口输出已稳定前缀，迟到点在水位内可修订未稳定尾部；GPS 断点开启新段。概率在对数域计算并规定并列路径。

## 用法

```go
m := dataeng.New(dataeng.Config{
    Window:    8,                // 有界 Viterbi 窗口（列数）
    Watermark: 30 * time.Second, // 迟到点允许的最大延迟
    Gap:       60 * time.Second, // GPS 断点阈值
    Beta:      50,               // 转移指数模型尺度（米）
}, func(from, to dataeng.Candidate) (float64, bool) {
    return routeDistance(from, to) // 调用方提供转移距离；false 表示不可达
})

// Add 返回新提交（稳定）的匹配；迟到点在水位内插入未稳定尾部并重算。
committed, err := m.Add(dataeng.Observation{
    Time:  ts,
    X:     x, Y: y,   // 平面坐标，用于点间直线距离
    Sigma: 5,         // 观测误差标准差（米）
    Cands: []dataeng.Candidate{{RoadID: "rd-1", Off: 3.2}},
})

provisional := m.Tail()  // 未稳定尾部的当前最优路径（可被修订）
final := m.Flush()       // 提交剩余尾部
```

## 语义约定

- **概率模型**：全部在对数域。发射为零均值高斯 `log N(off; 0, σ)`；转移为指数模型 `log Exp(|route−linear|; β)`，不可达转移为 `-Inf`。
- **稳定前缀**：未稳定尾部超过 `Window` 列时，从最优末态回溯提交最旧列；已提交结果不可再变。
- **迟到点**：时间戳早于最新点、但晚于已提交前缀且不超过 `Watermark` 时，按时间插入尾部并从插入点重算；否则返回 `ErrTooLate`，重复时间戳返回 `ErrDuplicateTime`。
- **GPS 断点**：相邻点间隔超过 `Gap` 时提交当前段全部尾部，`Segment` 递增（1 起），新点开启新段。
- **并列裁决**：候选按 `(RoadID, Off)` 排序；回溯前驱与最优末态并列时一律取字典序最小 RoadID，结果与候选输入顺序无关。
