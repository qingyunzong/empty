# NATS JetStream 序列缺口修复

数据归档器需要可直接接入 TypeScript JetStream 消费状态组件，区分 stream sequence 与 consumer sequence，处理 redelivery、flow control 和 heartbeat。发现 stream 缺口时暂停提交并生成一次范围补取；补取与实时消息交错仍按 stream 序发布，删除导致的永久空洞明确记录。
