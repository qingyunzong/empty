# OData delta link 世代切换

企业目录采集服务要可直接接入 TypeScript OData delta 遍历组件，区分 nextLink、deltaLink、removed reason 和分页内同实体多次变化。只有完整走完当前世代才提交新 deltaLink；中途取消沿原 nextLink 恢复。服务端返回410时开启全量新世代，但旧删除记录不得污染新快照。
