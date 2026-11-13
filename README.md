# 特征点时一致回填

特征平台需要可直接接入 Go point-in-time join 组件，为每个训练事实选择 event time 不晚于事实且 created time 不晚于训练快照的特征版本。TTL、回填修订和删除墓碑分别处理；同时间版本用 source sequence 裁决，避免未来信息泄漏。

## 包结构

- `types.go`：`FeatureVersion`（特征版本）、`Fact`（训练事实）、`Result`（选择结果）及状态/原因枚举。
- `store.go`：`FeatureStore` 存储接口与线程安全的 `MemoryStore` 参考实现，版本按 event time 降序、source sequence 降序、created time 降序排列。
- `joiner.go`：`Joiner` 点时连接核心，支持版本级 TTL 与全局默认 TTL。

## 选择语义

对每个 `Fact{Key, EventTime, SnapshotTime}`，按以下规则扫描候选版本：

1. **双时间界（防未来信息泄漏）**：`version.EventTime <= fact.EventTime` 且 `version.CreatedTime <= fact.SnapshotTime`，边界均为闭区间。晚于快照入库的回填修订对本次训练不可见。
2. **同时间裁决**：event time 相同的版本取 `SourceSequence` 最大者；再相同取 created time 最新者。
3. **TTL**：仅对普通 upsert 生效，在 `fact.EventTime > version.EventTime + TTL` 时视为过期（边界时刻仍有效）。版本自带 TTL 优先，否则使用 `WithDefaultTTL`；均未设置则永不过期。
4. **删除墓碑**：tombstone 不受 TTL 限制，一旦命中即永久遮蔽更旧版本；更晚 event time 的新 upsert 可重新复活该特征。墓碑自身同样受双时间界约束。
5. **结果状态**：`StatePresent` 返回取值；`StateTombstoned` 表示命中删除；`StateAbsent` 附带 `ReasonNoVersion`、`ReasonNoEligibleVersion` 或 `ReasonTTLExpired` 原因。

## 用法

```go
package main

import (
	"time"

	"example.org/dataeng/q0198"
)

func main() {
	store := dataeng.NewMemoryStore[string, float64]()
	store.Put(
		dataeng.Upsert("user:1:ctr", t1, t1, 1, 0.31, 24*time.Hour),
		dataeng.Tombstone[string, float64]("user:1:ctr", t2, t2, 2),
		dataeng.Upsert("user:1:ctr", t3, t3, 3, 0.42, 24*time.Hour),
	)

	joiner := dataeng.NewJoiner(store, dataeng.WithDefaultTTL[string, float64](7*24*time.Hour))
	results, err := joiner.Join([]dataeng.Fact[string]{
		{Key: "user:1:ctr", EventTime: t4, SnapshotTime: t5},
	})
	if err != nil {
		// 存储访问失败
	}
	for _, result := range results {
		switch result.State {
		case dataeng.StatePresent:
			_ = result.Value // 点时一致的特征值
		case dataeng.StateTombstoned:
			// 特征已删除
		case dataeng.StateAbsent:
			_ = result.Reason // 无版本 / 越界 / TTL 过期
		}
	}
}
```

## 接入自有存储

实现一个方法即可接入特征平台的在线/离线存储：

```go
type FeatureStore[K comparable, V any] interface {
	Versions(key K) ([]dataeng.FeatureVersion[K, V], error)
}
```

返回切片无需预先排序，`Joiner` 内部按规范顺序裁决；实现只需保证返回数据可被调用方安全读取。
