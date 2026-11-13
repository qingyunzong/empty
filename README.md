# IMAP BODY 分段重组

归档服务要调用可导入的 Go IMAP BODY 分段重组库，按 section、origin offset 和实际 literal 长度拼接并检测空洞、重叠冲突及服务器截短。相同字节重叠可幂等接收，冲突使当前消息失败；并发抓取不同 section 隔离，完成条件不能只信请求长度。
