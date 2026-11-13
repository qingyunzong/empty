# Pub/Sub 有序键租约接力

消息落地服务需要可导入的 Go Pub/Sub 有序键状态组件，协调 ack deadline、modifyAckDeadline、nack 与订阅重投。同一 ordering key 同时只有一个活跃前缀；租约丢失后旧处理者不能提交。无序键可独立推进，恢复后保持每键发布顺序。
