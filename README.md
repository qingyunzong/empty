# Prometheus remote_write 去重

`dataeng` 是一个无外部依赖的 Go 样本去重组件，可直接放在 remote-write
入口之后使用。

- 样本身份为「规范化标签集 + timestamp + value 的 IEEE 754 bits」，因此
  NaN payload 与 `-0.0/+0.0` 都按 bit 精确比较。
- 同标签、同 timestamp、不同 bits 会记录为 `Conflict`，首个已提交值不会被
  静默覆盖。
- Prometheus stale marker（`0x7ff0000000000002`）单独计入 `Stale`，不会被
  当作普通 NaN 或普通样本。
- Exemplar 使用自己的标签集、timestamp 与 value bits 单独去重，不与样本
  身份混用。
- 批次携带 external labels 与 leader generation。分组键会移除
  `__replica__`、`replica`、`prometheus_replica`（也可配置），同一 HA 副本
  对落入同一分区。
- 新世代可以提交并解决旧世代的同时间冲突；迟到旧世代的样本会被记录为
  `Rejected`，不能覆盖新世代已提交的值。默认还会按世代维护提交水位，
  旧世代不能补写新世代水位之前的 timestamp；开启 `StrictGeneration`
  后会拒绝旧世代的全部样本。

```go
d := dataeng.NewDeduplicator(
	dataeng.WithReplicaLabel("__replica__"),
	dataeng.WithLeaderGeneration(1),
)

result := d.IngestBatch(dataeng.Batch{
	ExternalLabels: dataeng.Labels{
		"cluster":     "prod",
		"__replica__": "a",
	},
	Replica:    "a",
	Generation: 1,
	Samples: []dataeng.Sample{{
		Labels:    dataeng.Labels{"__name__": "up", "job": "api"},
		Timestamp: 1700000000000,
		Value:     1,
	}},
})

_ = result.Accepted
_ = result.Duplicates
_ = result.Conflicts
_ = result.Stale
```

一个 `Deduplicator` 会跨请求保存已提交身份；若只需要对单批数据去重，可使用
`dataeng.Deduplicate(samples)`。
