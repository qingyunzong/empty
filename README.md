# AMQP unsettled delivery 恢复

AMQP 1.0 接入器需要可导入的 Go delivery 状态库，关联 link epoch、delivery-id/tag、settled 标志和事务 outcome。断链重连后按 unsettled map 对账，旧 link 的迟到 disposition 不作用于新世代；accepted 只在落库提交后生成，重复转移不重复写入。
