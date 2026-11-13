# 浏览器性能日志关联

采集监控服务需要可导入的 Go DevTools 事件归并库，把 requestId 在 redirect、ExtraInfo、cache、preflight 和 target attach 间的多阶段事件合成请求记录。事件可乱序，缺失可选事件不阻塞终态；同 id 在新 target 世代重用时必须隔离。
