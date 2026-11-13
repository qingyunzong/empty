# journald cursor 世代恢复

主机日志连接器需要可直接接入 Go journal cursor 状态组件，处理 seek cursor、boot id、realtime/monotonic timestamp 与 vacuum 导致的游标失效。恢复时先验证 cursor 对应条目，再决定继续或按时间补扫；补扫结果按唯一字段集去重，跨 boot 不比较单调时间。
