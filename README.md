# Postgres 逻辑复制关系世代

Postgres 采集器需要可导入的 Go pgoutput 状态库，处理 Relation、Begin/Commit、streaming transaction、origin 和 truncate 消息。tuple 解码绑定消息当时的 relation schema；DDL 后旧事务仍用旧世代。确认 LSN 只能越过已持久化的完整提交。
