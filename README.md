# JSON:API included 资源闭包

JSON:API 同步服务需要可导入的 TypeScript 资源合并库，解析 primary data、included、relationship linkage 和局部字段集。相同 type/id 的多份表示按字段来源合并，冲突值拒绝整轮；未包含关系保持 unknown 而非空。输出可达资源闭包和缺失 linkage。
