# 列级 lineage 通配符迟绑定

元数据服务需要可导入的 TypeScript SQL 血缘绑定库，先保留 SELECT *、qualified star 和动态 schema 的未决节点，获得执行时 schema 后按 field id 展开。视图重建生成新世代；旧查询血缘不被新列反向污染，歧义来源返回候选证据。
