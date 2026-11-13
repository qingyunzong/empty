# Hudi 文件组 timeline 视图

湖仓读取器需要可导入的 Go Hudi timeline 组件，联合 completed/inflight/rollback/restore instant、file group 和 log block 构造 snapshot 与 read-optimized 视图。回滚只撤销目标 instant 的有效切片；归档 timeline 保留所需谱系，重复 instant 内容冲突。
