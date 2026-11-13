# Server-Sent Events 游标恢复

采集网关需要可导入的 Go SSE 流解析器，处理 UTF-8 跨块、CR/LF、data 多行、id 空值与 retry。只有完整空行结束事件，Last-Event-ID 在输出确认后提交；连接中断时半事件丢弃。重复 id 不自动去重，由调用方策略决定并保留原到达序。
