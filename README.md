# 窗口函数 peer 组跨批

SQL 执行层需要可嵌入的 C++ 窗口状态组件，支持 ROWS/RANGE/GROUPS frame、EXCLUDE、null ordering 和 peer group。分区分批输入时延迟需要未来边界的行；外部排序恢复不改变稳定顺序。结果与完整分区参考计算一致。
