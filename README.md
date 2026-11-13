# 远程 shuffle 分区清单提交

批处理 shuffle 服务需要可导入的 Go 分区清单库，每个 map attempt 写不可变 chunk，胜者用条件提交发布 manifest。reduce 只读取所有胜者清单；失败 attempt 的迟到提交拒绝。chunk 校验失败定位 map/partition，重算不会混入旧 attempt 数据。
