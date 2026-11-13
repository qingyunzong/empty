# GraphQL Relay 连接恢复

数据同步服务要可直接接入 TypeScript Relay connection 遍历库，联合 pageInfo、edge cursor 和节点版本推进。服务端插入或删除边时允许页面重叠，但 cursor 不前进、倒退或重复必须触发有界恢复；每条输出携带首次观察位置，取消后恢复不重放已确认批次。
