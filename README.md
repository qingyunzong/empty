# syslog octet-counting 混合帧

日志网关需要可嵌入 C++ syslog 流解帧器，支持 RFC 6587 octet-counting 与 non-transparent framing 的明确配置。长度前缀可跨块且必须最短合法，消息内换行不切帧；错误后只在可靠边界恢复。每帧保留原始字节范围和接收时间。
