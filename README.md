# 自适应 join 切换状态迁移

执行器需要可嵌入的 C++ 自适应 join 组件，在采样后从 broadcast 切换 partitioned，或从 hash 切换 sort-merge。切换点前后的行归属有明确栅栏；已输出结果不能重算。迁移失败回滚到旧计划，结果与固定计划参考一致。
