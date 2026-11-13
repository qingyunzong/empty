# Paimon changelog producer 切换

湖仓写入层需要可导入的 Go changelog 模式协调组件，在 input、lookup、full-compaction producer 间切换。切换点绑定 snapshot 和 bucket epoch；不得漏发或重复 before/after。恢复时从提交元数据选择同一模式，未完成 compaction 不改变可见 changelog。
