容量平台需要供压测控制器调用的Go在线判定库，根据吞吐、延迟分位和错误率的置信区间选择下一档负载，并识别饱和拐点。预热与抖动样本分开，预算耗尽返回未闭合区间。用合成响应曲线验证不会越过安全上限且区间逐轮收缩。

## `loaddecide` 在线判定库

`loaddecide` 是零第三方依赖的 Go 包，供压测控制器按轮驱动：在每个负载档分别
灌入预热样本和抖动（实测）样本，库基于三类指标的置信区间给出安全判定、下一档
负载和饱和拐点括号区间。

### 置信区间（`stats.go`）

- 吞吐：按固定窗口统计成功请求数，使用 Student-t 均值区间（`tCritical` 由正则化
  不完全 Beta 反演得到，仅依赖标准库 `math`）。
- 错误率：Wilson score 区间，小样本和极端比例下仍落在 `[0,1]` 内。
- 延迟分位：次序统计量法的非参数分位区间，R-7 插值估计点。
- 样本量不足时区间边界为 `NaN`，由精度门直接拒绝，避免在证据不足时给出激进结论。

### 预热 / 抖动隔离（`collector.go`）

- `AddWarmup` 与 `AddMeasured` 进入两个独立样本池；`BeginMeasured` 后再写预热
  样本会返回 `ErrWarmupClosed`，从结构上杜绝混合。
- 预热数据只保留计数用于诊断，所有置信区间只由抖动样本计算。
- `PrecisionGate` 同时约束最小窗口数、最小请求数和三类区间的最大宽度。

### 搜索状态机（`decider.go`）

- 负载档严格升序，每次只向相邻的下一档推进，并且永远不会推荐超过
  `MaxSafeLevelIndex`（安全上限）的档位。
- 保守安全判定：延迟分位或错误率的置信上界越过 SLO 即判不安全，闭合
  `[最高安全档, 首个不安全档)`。
- 饱和拐点：相邻安全档之间，吞吐相对增益不超过 `SaturationGainFloor` 且置信
  区间重叠时判为饱和（曲线变平而非正常抖动），同样闭合括号。
- 预算（轮次 `MaxRounds`、请求数 `MaxMeasuredRequests`）在闭合前耗尽时返回
  `StatusExhausted`，`KneeResult.Closed == false`、`BoundingUnsafeIndex == -1`，
  `LoadInterval` 的高端为 `NaN`，即明确的未闭合区间。
- 全部安全档一直探到安全上限则返回 `StatusCeiling`。

### 合成响应曲线验证（`*_test.go`、`synthetic.go`）

`SyntheticCurve` 建模容量饱和（吞吐在 `CapacityRPS` 处弯平）、排队延迟
（`base/(1-utilization)`）和过载拒绝概率，固定种子可复现。测试断言：

- 12 个随机种子下拐点括号一致，且任何探测档位与括号上界都不越过安全上限。
- 括号下界单调不降、上界不扩张，闭合后索引宽度严格逐轮缩小；档位每次只 +1。
- 轮次预算和请求预算分别耗尽时都返回未闭合区间，高端为 `NaN`。
- 预热阶段灌入极端延迟/失败样本不影响实测判定。
- 三类置信区间宽度随样本量增加而收缩；饱和拐点在 SLO 不触发时仍能独立闭合。

### 控制器最小用法

```go
decider, _ := loaddecide.NewDecider(cfg)
for decider.Status() == loaddecide.StatusRunning {
    load, _, ok := decider.NextLevel()
    if !ok { break }
    // 预热（不计入判定）
    for _, obs := range warmupSamples(load) { decider.AddWarmup(obs) }
    // 抖动，证据不足时 VerdictUnknown，控制器继续在同一档采样
    for {
        window, obs := measureWindow(load)
        decider.AddWindow(window)
        for _, o := range obs { decider.AddMeasured(o) }
        v, _ := decider.Evaluate()
        if v.Verdict != loaddecide.VerdictUnknown ||
            decider.Status() != loaddecide.StatusRunning { break }
    }
}
result := decider.Result()
low, high := result.LoadInterval(cfg.Levels) // 未闭合时 high 为 NaN
```

运行测试：`go test ./...`（带竞态检测：`go test -race ./...`）。
