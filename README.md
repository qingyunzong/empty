# SQL Server CDC LSN 边界

变更连接器需要可直接接入 Go SQL Server CDC 状态库，按 start_lsn、seqval、operation 和 update mask 组合更新前后行。查询区间端点使用映射函数精确推进，cleanup 导致最小 LSN 越过水位时报告缺口并触发新快照，不能静默跳到当前。
