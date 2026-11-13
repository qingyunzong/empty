# 条件分支跳过状态传播

工作流引擎要接入可导入的 TypeScript 分支状态求值库，区分 success、failed、skipped、upstream_failed 和 removed。join 节点按 all/any/none_failed 等规则决定；动态移除不等于成功。增量状态变化只产生一次合法终态转换。
