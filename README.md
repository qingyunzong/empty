# Exactly-once source offset 联合提交

采集运行时需要可嵌入的 C++ source-offset 事务组件，把多分区读取位置与 sink commit token 联合保存。任一 sink 失败不推进任何分区；恢复从最后完整提交继续。分区增删有世代，旧分区的迟到确认不能推进新分区。
