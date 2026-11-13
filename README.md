# OPC UA subscription 序号修复

工业采集层需要可导入的 Go OPC UA subscription 状态库，维护 publish sequence、available sequence、republish 和 monitored item queue。检测缺口先 republish，确认只推进连续前缀；服务器重建订阅生成新世代，旧通知不得混入。
