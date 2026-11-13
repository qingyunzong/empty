// Package dataeng 提供主机日志连接器的 journal 游标状态组件：
// 封装 seek cursor、boot id、realtime/monotonic 时间戳的持久化状态，
// 处理 journal vacuum 导致的游标失效，恢复时先验证游标对应条目，
// 再决定从游标继续或按时间补扫；补扫结果按唯一字段集去重，
// 且跨 boot 不比较单调时间。
package dataeng
