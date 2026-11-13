# Debezium 事务边界重组

CDC 落地服务需要可导入的 TypeScript 事务重组库，消费 Debezium 数据事件与 transaction metadata，把跨 topic、跨分区的事件按 transaction id、total_order 和 data_collection_order 组成提交批次。重复事件须内容一致，缺序号阻止提交；非事务事件独立推进。崩溃恢复后只发布完整事务，超时只能报告缺口，不能拆分伪提交。
