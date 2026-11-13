# 特征 point-in-time join

训练集构建器需要可导入的 Go point-in-time join 组件，为每条标签选择 event time 不晚于标签且 ingestion cutoff 内的最新特征。并列按版本键；TTL 与回填世代公开。任何未来数据不得泄漏，结果可由逐实体排序参考核验。
