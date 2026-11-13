# 多目标 sink 提交协调

ETL 编排器需要可导入的 TypeScript 多 sink 提交组件，各 sink 仅提供 prepare/commit/abort 和幂等 token，不保证分布式事务。组件记录可恢复决策，prepare 全成才决定 commit；决定后个别 commit 暂失败必须重试而不能 abort。恢复不产生相反决策。
