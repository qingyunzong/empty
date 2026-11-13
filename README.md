# 多区域 API 冲突版本

全球 SaaS 连接器要可直接接入 Go 多区域归并库，区域返回各自 version vector、更新时间和 tombstone。可比较版本取支配者，并发版本保留冲突集合供策略处理；墙钟只作展示不裁决。区域暂失联不生成删除，恢复后重放幂等。

## 设计原则

- **唯一裁决依据是 version vector**：`VersionVector.Compare` 给出 `Equal / Before / After / Concurrent` 四种因果关系。支配版本替换旧版本，并发版本共同保留。
- **墙钟只展示**：`Record.UpdatedAt` 仅通过 `Store.DisplayUpdatedAt` 暴露给界面，任何归并、去重、策略路径都不读取它，时钟回拨或偏斜不影响收敛。
- **tombstone 是显式的版本化记录**：删除只能由 `Store.Delete` 或带 `Tombstone: true` 的区域记录产生。区域拉取失败或返回空数据绝不合成删除。
- **失联安全 + 幂等重放**：连接器 `Pull` 报错时库内状态不变；恢复后重放同一批事件，靠 `EventID` 去重与相等 vector 判定保证无副作用，可在任意偏移量重试。

## 包结构

- `vector.go` — version vector 的递增、合并与因果偏序比较。
- `record.go` — 区域记录（vector、payload、tombstone、墙钟时间、EventID）。
- `store.go` — 并发安全的归并存储：`Apply / ApplyBatch / Put / Delete / Versions / Lookup / Snapshot`。
- `policy.go` — 冲突策略接口 `ConflictPolicy`，内置 `RetainPolicy`（默认保留冲突集）与 `RegionPriorityPolicy`（按区域优先级裁决）。
- `connector.go` — 连接器接入点 `RegionSource` / `SourceFunc`，以及 `Ingest` 与恢复用的 `Replay`。

## 归并语义

对同一 key 的新记录与每个留存版本比较：

1. 相同 `EventID` 已见过 → `Duplicate`，忽略。
2. vector `Equal`（同因果历史，即使无 EventID）→ `Duplicate`，忽略。
3. 新 vector `Before` 任一留存版本 → `Stale`，拒绝。
4. 新 vector `After` 某留存版本 → 移除被支配的旧版本。
5. 与所有留存版本 `Concurrent` → 加入冲突集，`ApplyResult.Conflicts > 1`。

`ApplyBatch` 先整体校验，再按 `(key, region, event)` 稳定排序处理，因此乱序投递与重放结果一致。

## 快速上手

```go
store := dataeng.New()

// 两个区域基于共同历史分叉，产生并发版本。
store.Apply(dataeng.Record{Key: "acct:1", Region: "us",
    Vector: dataeng.VersionVector{"us": 2, "eu": 1}, Value: []byte("us")})
store.Apply(dataeng.Record{Key: "acct:1", Region: "eu",
    Vector: dataeng.VersionVector{"us": 1, "eu": 2}, Value: []byte("eu")})

store.HasConflict("acct:1") // true：Effective/Lookup 不擅自挑选赢家

// 策略层裁决；也可实现 dataeng.ConflictPolicy 自定义。
store.Resolve("acct:1", dataeng.RegionPriorityPolicy{Priority: []string{"eu", "us"}})

// 连接器接入：Pull 失败只报告 Offline，不动现有数据。
source := dataeng.SourceFunc{ID: "eu", PullFn: connector.Pull}
store.Ingest(source)
store.Replay(source) // 恢复后重放，EventID/vector 双重幂等
```

本地写入用 `Store.Put` / `Store.Delete`，它们在 key 当前合并 vector 之上递增本区域计数，天然支配该区域此前的历史。

## 验证

```sh
go vet ./...
go test -race -count=1 ./...
```

测试覆盖：支配替换、陈旧拒绝、并发冲突集、区域优先级与保留策略、显式 tombstone 及其与并发写入的共存、EventID/vector 双重幂等、离线不删除、恢复重放收敛、墙钟不参与裁决。
