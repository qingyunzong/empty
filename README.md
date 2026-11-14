# 唯一键近实时冲突检测

流式质量入口需要可直接接入 Go 唯一键状态库，按窗口和业务时区检测重复。更新与删除会撤销旧键，占用从事件时间生效；迟到事件在允许期内修订冲突组。键规范化版本改变时开启新世代，不能跨规则比较。

## 用法

```go
store := dataeng.NewStore()
store.RegisterRule(dataeng.Rule{
    ID:          "customer",
    NormVersion: 1,
    Normalize:   normalize, // func(string) string
    Window: dataeng.WindowSpec{
        Size:     24 * time.Hour,
        Location: cst, // 业务时区，窗口按当地零点切分
    },
    AllowedLateness: 2 * time.Hour,
})

out, err := store.Apply("customer", dataeng.Event{
    EntityID:  "e1",
    Key:       "CUST-001",
    Op:        dataeng.OpUpsert, // 或 OpDelete
    EventTime: eventTime,
})
// out.Status: accepted / duplicate / rejected-late
// out.ConflictGroup: 冲突组成员；out.Owner: 事件时间最早的占用者
```

## 语义

- **窗口与时区**：`WindowSpec` 按业务时区的当地零点切分滚动窗口，整日窗口不受夏令时漂移影响。
- **更新与删除**：同一实体的更新先撤销旧键再占用新键；删除仅撤销。撤销信息经 `Outcome.RevokedKey` / `RevokedWindow` 返回。
- **事件时间生效**：冲突组内事件时间最早的声明为占用者（`Owner`），水位线也按事件时间推进。
- **迟到事件**：事件时间早于 `水位线 - AllowedLateness` 的事件被拒绝且不改变状态；允许期内的迟到事件正常修订其窗口的冲突组。
- **世代隔离**：`NormVersion` 改变时 `RegisterRule` 开启新世代，各世代与不同规则之间的键状态完全隔离，不做跨规则比较。
- `Store.Conflicts(ruleID)` 返回当前世代未解决的冲突组列表。`Store` 可并发使用。
