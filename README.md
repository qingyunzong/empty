# Prometheus remote_write 去重

指标入口要可直接接入 Go 样本去重组件，以规范化标签集、timestamp 与 value bits 识别完全重复，并区分同时间冲突值、stale marker 和 exemplars。多个副本按 external labels 分组后使用可配置选主世代；迟到旧主样本不能覆盖已提交新主。
