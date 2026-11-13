# SAP ODP delta queue 确认

企业数据连接器要可导入的 TypeScript delta queue 状态机，把 subscriber、request id、package id 和最终确认绑定。包可重复拉取且乱序，只有整 request 所有包落库后确认；取消后迟到包不复活。初始化全量与后续 delta 使用不同世代且不可交叉。
