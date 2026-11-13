# Savepoint 算子 UID 映射

流作业升级器要可直接接入 TypeScript savepoint 映射组件，根据稳定 operator UID、并行度、max parallelism 与 key-group range 把旧状态分配给新 subtask。UID 缺失、重复或状态 schema 不兼容时给出具体阻断；scale in/out 后每个 key-group 恰好归属一次。
