# CoAP Observe 序列新旧判断

受限设备采集器需要可嵌入 C++ CoAP Observe 状态组件，按24位序列的半范围规则、响应时间和 Max-Age 判断新旧通知。重注册开启新世代，旧 token 的迟到包失效；confirmable 重传只交付一次。休眠超过规则窗口时要求重新同步，不猜序列。
