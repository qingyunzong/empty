# 双时态事实修订传播

审计仓库需要可嵌入的 C++ bitemporal 状态组件，记录 valid-time 与 transaction-time 区间。回溯修订切分原版本但保留历史可查询性；撤销只关闭当前事务版本。任意 as-of 查询结果与按两维区间过滤的参考模型一致。
