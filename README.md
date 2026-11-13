# OData deltaLink 墓碑合并

企业数据同步器要接入可导入的 TypeScript OData delta 组件，消费 nextLink、deltaLink、实体更新和 removed 墓碑。分页中途失败沿原链恢复；新 deltaLink 仅在整轮原子落库后生效。实体重建与迟到墓碑按服务端版本裁决，不能删除更晚世代。
