# 作业升级状态映射验证

流处理升级器需要可导入的 Go state mapping 库，依据 operator uid、max parallelism、key-group 和 serializer snapshot 将旧状态映射到新拓扑。拆并算子需显式规则；遗漏或重复 key-group 拒绝升级。生成守恒证明后才发布恢复计划。
