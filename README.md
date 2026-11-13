# 数据集就绪多生产者世代

工作流入口需要可导入的 TypeScript dataset readiness 组件，生产者按分区、schema hash 和发布世代发信号。消费者声明 all/any 与允许 schema；撤回使未启动任务重新等待，已启动任务固定旧快照。乱序重复信号不重复触发。
