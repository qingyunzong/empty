# 分布式 exchange credit 重放

查询 exchange 层需要可导入的 Go 数据页传输协调器，维护 stream epoch、page sequence、credit 和 ack。重连从双方确认前缀重放，旧 epoch ack 无效；页只向下游交付一次。取消传播释放信用和缓冲，守恒检查证明无丢页及无凭空信用。
