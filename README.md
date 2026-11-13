# OpenTelemetry temporality 转换

指标入口需要可嵌入的 C++ cumulative/delta temporality 转换组件，按 resource、scope、attribute 和 start time 维护状态。进程重启、计数器 reset 与乱序点分开识别；缺前值返回 unknown 区间。分片恢复不产生负增量或重复累计。
