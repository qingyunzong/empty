# 告警规则引擎

供通知路径调用的 Go 规则引擎。它维护活动告警与一份原子规则快照，按标签
执行分组、抑制和静默，并保证一次求值得到完整、去重的通知集合。

## 使用

```go
engine, err := formal.NewEngine(formal.Config{
    GroupBy: []string{"env", "service"},
    Inhibitions: []formal.InhibitionRule{{
        Name:           "critical-hides-warning",
        SourceMatchers: []formal.Matcher{{Name: "severity", Value: "critical"}},
        TargetMatchers: []formal.Matcher{{Name: "severity", Value: "warning"}},
        Equal:          []string{"env", "service", "instance"},
    }},
    Silences: []formal.Silence{{
        ID:       "mute-db",
        Matchers: []formal.Matcher{{Name: "service", Value: "db"}},
        StartsAt: time.Now().Add(-time.Hour),
        EndsAt:   time.Now().Add(time.Hour),
    }},
})
if err != nil {
    return err
}

engine.AddAlerts(alerts...)

// 完整当前视图，适合状态展示或全量对账。
report := engine.Snapshot(time.Now())
for _, decision := range report.Decisions {
    // decision.Kept、decision.Suppression、decision.Rule 说明告警去留。
}

// 通知路径使用增量视图。相同通知 ID 不会重复返回。
fresh := engine.Poll(time.Now())
for _, notification := range fresh {
    send(notification)
}
```

`Evaluate(config, alerts, now)` 是无状态的纯函数版本，适合离线校验。

## 语义

- **告警身份**：`Labels` 的规范化字符串就是指纹。相同标签的重复到达只保留
  一份，并保留最早的 `StartsAt`；标签顺序和 map 迭代顺序不影响结果。
- **匹配**：缺失标签按空字符串处理。正则匹配两端锚定，例如 `prod` 不会
  匹配 `prod-eu`。
- **静默**：匹配所有 matcher 且 `now` 位于 `[StartsAt, EndsAt)` 时生效。
  零值 `StartsAt` 表示立即开始，零值 `EndsAt` 表示不过期。
- **抑制**：仅当源告警匹配 `SourceMatchers`、目标告警匹配
  `TargetMatchers`、`Equal` 中每个标签在双方取值相同，且源目标不是同一
  告警时才生效。抑制源即使自身被静默或抑制，仍可作为其它告警的源。
- **交集裁决**：静默与抑制同时命中时静默优先。同类多规则命中的顺序为：
  静默按开始时间、结束时间、规则键、配置下标；抑制按规则键、配置下标。
  因此裁决不依赖 map 遍历顺序或告警到达顺序。`Decision.Silenced` 与
  `Decision.Inhibited` 会同时报告两项命中，便于审计交集。
- **分组**：`GroupBy` 去重并排序，缺失的分组标签写入空字符串。组键和组内
  告警都按规范顺序排列；一次求值中每个组、每个告警只出现一次。
- **规则更新**：`UpdateRules` 先完整校验再原子替换。非法规则被拒绝，旧配置
  保持不变；成功更新不会清空告警状态或已投递记录。
- **增量通知**：`Notification.ID` 由组键和排序后的告警指纹组成。`Poll`
  对相同 ID 至多返回一次，所以重复告警、无变化的规则更新、以及切换后回到
  原分组都不会产生重复通知。`ResetDelivery` 用于显式开启新的投递周期。

## 验证

`property_test.go` 使用独立的朴素循环模型，不调用引擎的规则选择辅助函数。
测试穷举 13 种操作（告警增删、重复到达、四套规则切换）的全部 4 步序列，
共 28,561 条；每条序列在每一步都重新计算并核对：

- 每个唯一告警是保留还是被静默/抑制；
- 每个通知组的分组标签与告警成员；
- 通知组、告警指纹和投递 ID 均无重复；
- `Poll` 只返回此前未投递的当前通知，规则更新与告警到达交错时不遗漏、
  不重复。

另有 120 组长达 60 步的随机交错序列对照。运行：

```sh
go test ./...
go test -race ./...
```
