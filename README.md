# MongoDB resume token 分片合并

MongoDB 采集服务需要可导入的 Go change stream 合并组件，按 clusterTime、分片 token 和事务信息生成全局可恢复序列。invalidate 关闭当前世代；迁移造成的重复事件按 document key 与事务证据去重。持久水位只推进到各活跃分片都越过的前缀。
