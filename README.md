# 事件采集的版本区间关联

遥测采集服务需要可导入的Go关联组件。调用方输入带设备ID、整数事件时间和唯一ID的观测，以及每个设备互不重叠、不可修订或删除的半开配置有效区间；配置可乱序到达。配置水位线W承诺此后不会出现起点小于W的新区间，事件水位线承诺此后不会出现时间小于W的新观测；两者初始均为负无穷且单调递增。仅当两个水位线均严格大于观测时间时，按事件时间数值升序、同时间按ID的UTF-8字节字典序输出该观测及覆盖它的配置，缺配置则输出未匹配。相同ID和内容重投忽略，异内容拒绝；区间重叠或违反水位线的输入均报错且状态不变。输出回调须按观测ID幂等；回调明确成功才移除观测，失败或结果不明时停止并允许以同一ID重试，调用方负责去重外部副作用。测试边界相接、配置迟到、重复冲突及双水位交错，并与批量参考结果比较。

## 组件用法

包路径为 `example.org/dataeng/q0010`，入口类型是 `dataeng.Correlator`。

```go
c := dataeng.NewCorrelator(func(r dataeng.Result) error {
    // r.Matched 为 false 且 r.Config 为 nil 表示未匹配；
    // 回调必须按 r.Observation.ID 幂等，并自行去重外部副作用。
    return deliver(r)
})

// 乱序输入配置区间（半开 [Start, End)）和观测。
_ = c.AddConfig(dataeng.ConfigInterval{DeviceID: "dev-1", Start: 10, End: 20, Payload: cfg})
_ = c.AddObservation(dataeng.Observation{ID: "evt-7", DeviceID: "dev-1", EventTime: 15, Payload: body})

// 两个水位线均严格越过观测时间后，观测才会按序触发回调。
_ = c.AdvanceObservationWatermark(21)
_ = c.AdvanceConfigWatermark(21)

// 回调失败或结果不明后，用同一批观测 ID 重试。
if err := c.Flush(); err != nil {
    var emitErr *dataeng.EmitError
    errors.As(err, &emitErr) // emitErr.ObservationID 即失败的观测 ID
}
```

## 错误语义

- `ErrDuplicateID`：观测 ID 重投但内容不同，状态不变。
- `ErrOverlap`：同设备区间重叠，或同边界区间重投但内容不同，状态不变。
- `ErrWatermark`：输入落在对应水位线之后（含水位线回退），状态不变。
- `ErrInvalidInterval`：区间不满足 `End > Start`。
- `EmitError`：包装回调失败及失败的观测 ID；该观测保留，可用 `Flush` 重试。

相同 ID 与内容的重投（无论是否已成功输出）一律忽略；所有方法并发安全，回调期间持有内部锁，因此回调内不得再次调用同一 `Correlator`。
