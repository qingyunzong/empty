# Pulsar 批消息索引确认

事件接入服务会调用可导入的 Go Pulsar 批消息确认状态库，联合 ledger、entry、batch index 与 cumulative ack。单条失败时只重投未确认索引，批次重投不得重复发布已提交输出；topic 卸载和订阅世代变化使旧 ack 失效。状态可序列化后精确恢复。
