# 维度层级 ragged rollup

OLAP 语义层要接入可导入的 TypeScript 不规则层级聚合库，成员可跳级、多父和按时态变更。rollup 按查询快照展开路径并依据 bridge weight 防重复；权重和不为1时显式报告。缓存绑定层级世代和有效区间。
