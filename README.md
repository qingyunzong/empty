# 可访问树差分快照

RPA 定位服务需要可导入的 TypeScript accessibility tree 差分库，以 backend node id、role、name 和关系边维护版本图。节点 ignored 状态变化可重挂子树，id 在文档切换后不可复用；查询绑定版本，增量应用结果与完整树重建保持一致。
