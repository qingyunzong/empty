# DynamoDB Streams 分片血缘

DynamoDB Streams 消费层要嵌入可导入的 TypeScript 分片血缘协调器，父分片完全消费后才开放子分片，并处理分裂、合并、iterator 过期和 trimmed data。每条记录按 event id 幂等；检查点包含开放血缘前沿，恢复不跳过未闭合父分片。
