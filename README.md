# Windows Event Log bookmark 合并

审计采集代理要可嵌入 C++ Event Log bookmark 协调层，把 channel、record id、provider 与 query 版本绑定。日志清除或 channel 重建开启新世代，旧 bookmark 不跳过新记录；订阅回调和补拉查询交错时按 record id 去重并保持顺序。
