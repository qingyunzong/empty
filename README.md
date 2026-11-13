# OTLP delta 指标累积

遥测处理器需要可嵌入 C++ delta-to-cumulative 状态组件，按 resource、scope、metric 和完整 attribute key 维护 start time 世代。进程重启、时间倒退或单调和下降时按类型重置；乱序 delta 在窗口内重排，超窗不改写已发布累计值。
