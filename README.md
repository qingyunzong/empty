# NATS JetStream 消费序列对账

JetStream 接入层要嵌入可导入的 TypeScript 序列对账库，同时跟踪 stream sequence、consumer sequence、redelivery count 和 pending。检测删除或重建消费者造成的缺口，pull 批次部分确认不越过失败项；重复消息内容冲突时停止对应流并给出证据。
