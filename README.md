# Kafka 事务标记跨分区可见性

流式落库层需要可导入的 Go 事务批次读取库，联合各分区数据、control batch、producer epoch 与事务标记，只向调用方交付完整已提交事务。分区乱序、leader 截断和 aborted transaction 不得泄漏；恢复后输出与按日志偏移重放一致。
