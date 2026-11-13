# SQL Server CDC update mask 合并

SQL Server 变更采集服务要接入可导入的 TypeScript update-mask 解释库，将同一 LSN/seqval 的 before、after 行配对，并按 capture instance schema 解析掩码。缺半边时保持待决，cleanup 水位越过后报告永久缺口；重启不重复发布已配对变更。
