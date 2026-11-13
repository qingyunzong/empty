# Postgres 逻辑复制关系世代

Postgres 采集器需要可导入的 Go pgoutput 状态库，处理 Relation、Begin/Commit、streaming transaction、origin 和 truncate 消息。tuple 解码绑定消息当时的 relation schema；DDL 后旧事务仍用旧世代。确认 LSN 只能越过已持久化的完整提交。

## 用法

```go
s := dataeng.NewState()
events, err := s.Apply(rawMsg) // 每条 pgoutput 消息
// DML/Truncate 事件随所属事务的 Commit 事件一起释放；
// 持久化后回报进度，再读取可确认的 flush 位置：
s.MarkPersisted(endLSN)
confirmed := s.ConfirmedLSN()
```

- `message.go`：pgoutput 线协议解析（Relation/Type/Insert/Update/Delete/Truncate/Begin/Commit/Origin/Message/Stream Start/Stop/Commit/Abort）。
- `relation.go`：`Relation` 世代、`Column`、`Tuple` 解码结果。
- `state.go`：`State` 状态机。事务在 Begin/Stream Start 时记录世代序号，tuple 按事务开始时的 relation 世代解码（同事务内新建的表回退到最早世代）；DDL 产生新世代后，旧事务仍用旧世代。`ConfirmedLSN` = min（最近完整提交的 end LSN, 已持久化水位），未完成的 streaming 事务会阻止其前进。
