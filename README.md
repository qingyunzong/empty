# DynamoDB Streams 分片继承

采集器要可直接接入 Go DynamoDB Streams 分片调度库，根据 parent/adjacentParent 依赖只在父分片完成后开放子分片。闭合分片水位与输出确认原子推进；reshard 图含缺失父节点时保守等待并报告。多工作者抢占使用租约世代，旧持有者不能提交。
