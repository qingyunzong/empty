# 相关子查询参数缓存隔离

查询服务需要可导入的 TypeScript correlated subquery 缓存库，以规范化参数、外层快照和权限上下文作为键。NULL 的三值语义、volatile 表达式和 limit 顺序决定是否可缓存；取消中的计算不发布。并发同键请求共享结果但独立接收取消。
