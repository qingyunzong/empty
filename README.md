# HL7 v2 分隔符动态解析

医疗数据网关需要可导入的 Go HL7 v2 事件解析组件，从每条 MSH 动态取得 field/component/repetition/escape/subcomponent 分隔符。转义序列可跨块，批消息内不同版本互不污染；异常 segment 记录原始范围，后续消息从可靠 MSH 边界恢复。
