# 递归 CTE 半朴素迭代

关系执行器需要可导入的 Go 递归 CTE 组件，维护 total/delta 集合，支持 UNION DISTINCT/ALL、搜索顺序和 cycle 标记。每轮只用上一 delta 扩展；资源上限到达返回未闭合状态。稳定键保证同一输入的输出与循环证据可复现。
