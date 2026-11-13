# OPC UA 订阅序号恢复

工业数据入口需要可导入的 Go OPC UA subscription 状态库，处理 publish sequence、availableSequenceNumbers、republish 与 keepalive。缺口先 republish，服务器确认不可用后标记永久缺失；transfer subscription 后旧 session 响应无效。确认只覆盖已持久化通知。
