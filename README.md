# WAL group commit durable prefix

状态服务需要可导入的 Go group-commit 协调库，多个事务共享一次 fsync，但每个回执只在其 WAL 尾已持久后返回。部分写、fsync 失败和取消不越过 durable prefix；恢复截断坏尾。事务回执顺序可晚于提交序，但持久性证明准确。
