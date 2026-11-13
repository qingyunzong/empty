# 指标 exemplar 血缘保留

监控数据管线需要可导入的 Go exemplar 关联库，把稀疏 trace exemplar 绑定到时间序列样本和存储块。重采样与 compaction 保留仍落在聚合区间的代表项并按稳定规则选取；删除原样本传播撤回，不产生悬挂 trace 引用。
