# 流式 Top-K 撤回语义

排名服务需要可嵌入 C++ changelog Top-K 算子，接收 insert/update_before/update_after/delete，按分组、分数和稳定并列键维护前 K。每次变更只输出必要 retract/insert，键更组视为跨组事务；恢复快照后输出序列与不中断执行相同。
