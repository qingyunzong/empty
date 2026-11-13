# Debezium schema history 重放

CDC 恢复服务需要可导入的 Go schema history 重建库，按 source position 重放 DDL、表 rename 与列序变更，为每条数据事件选择不晚于其位置的 schema。历史记录重复幂等，位置相同而内容冲突须停止；压缩快照必须证明覆盖区间且能与完整重放产生同一 schema 哈希。
