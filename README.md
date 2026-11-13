# MongoDB change stream 恢复令牌

文档同步服务需要可导入的 TypeScript change stream 状态库，处理 resume token、invalidate、rename、事务批次与 fullDocument lookup。令牌只在对应输出批次确认后提交；lookup 得到更新后版本时保留事件时点与读取时点两种证据。history lost 时启动新快照世代，不拼接旧游标。
