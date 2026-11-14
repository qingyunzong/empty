# PostgreSQL logical slot 快照衔接

`example.org/dataeng/q0022` 是一个无数据库驱动依赖、可直接导入的 Go 组件，用于把 PostgreSQL exported snapshot 的初始拷贝安全衔接到同一 logical slot 的后续 WAL。

## 设计约束

- **一次性绑定**：`Snapshot` 同时记录 exported snapshot 名称、`ConsistentPoint`、database/slot 和初始 relation schema。绑定摘要写入每个 checkpoint，重跑时若 snapshot、slot、consistent point 或任何初始 schema 不一致，直接返回 `ErrSnapshotMismatch`，不会静默续跑。
- **快照按主键去重**：canonical PK 由 relation 版本、PK 列顺序和长度前缀编码生成。崩溃后重新扫描快照时，已确认的行不会再次交给 sink；同一主键但内容不同的重复行返回 `ErrSnapshotRowConflict`。
- **WAL 按 LSN 去重**：`Change.LSN` 是唯一 WAL record 位置，也是去重键；`CommitLSN` 只作事务元数据。flush 使用 record LSN 而不是 commit LSN，避免事务跨 batch 时崩溃后跳过剩余 record。
- **DDL 版本隔离**：每个 `Relation` 是不可变的 `(relation ID, version)` 版本。DML 必须声明 `RelationVersion`；协调器只做精确解析，并把解析后的 `Change.Schema` 附在交给 sink 的变更上。旧 tuple 永远使用旧版本，不会回退到“最新 schema”。
- **仅确认后推进 flush**：`Sink.ApplySnapshot` / `Sink.ApplyChanges` 返回 nil 表示数据已持久确认，之后才写 checkpoint。sink 报错时 `FlushLSN` 保持不变。
- **任意崩溃点恢复**：`FileStateStore` 使用同目录临时文件、`fsync`、原子 rename 和目录 `fsync`。崩溃可能发生在“sink 已确认、checkpoint 未写”的窗口，因此 sink 必须幂等：快照按 PK upsert，变更按 LSN 去重。

## 最小用法

```go
snapshot := dataeng.Snapshot{
    Database:         "app",
    Slot:             "app_slot",
    ExportedSnapshot: "00000003-0000001B-1",
    ConsistentPoint:  dataeng.MustParseLSN("0/16B6C50"),
    Relations:        []dataeng.Relation{usersV1},
}

coordinator, err := dataeng.NewCoordinator(dataeng.Config{
    Snapshot:       snapshot,
    Store:          dataeng.NewFileStateStore("/var/lib/sync/checkpoint.json"),
    SnapshotSource: snapshotSource, // 实现 OpenSnapshot
    WALSource:      walSource,      // 实现 OpenWAL，从 FlushLSN 开始
    Sink:           sink,           // 实现幂等、持久确认的 ApplySnapshot/ApplyChanges
    BatchSize:      500,
})
if err != nil {
    return err
}
// 首次运行：完成快照，再从 consistent point 跟 WAL。
// 重启运行：自动跳过已确认快照行和 <= FlushLSN 的变更。
err = coordinator.Run(ctx)
```

也可以分阶段调用 `RunSnapshot` 和 `RunWAL`，或使用 `NewMemoryStore`、`NewMemorySink`、`NewStaticSnapshotSource`、`NewStaticWALSource` 做本地验证。

## 数据约定

`Row` 是 `map[string]Value`，`Value` 保存 PostgreSQL text 表示，并用 `Null` 区分 SQL NULL。快照行必须是该 relation 版本的完整 tuple；WAL 的 `Before`/`After` 至少包含主键列（delete 可只带 replica identity 列）。

`ChangeKind` 支持 `ChangeInsert`、`ChangeUpdate`、`ChangeDelete`、`ChangeTruncate` 和 `ChangeSchema`。`ChangeSchema` 的 `DDL` 提供完整的新 relation 版本，协调器先验证并注册，再处理同一 batch 中引用新版本的 tuple。

`Snapshot.Relations` 中每个 relation ID 只能出现一个初始版本；后续版本必须通过带递增 `Version` 的 `ChangeSchema` 引入。sink 不应缓存传入的 batch slice，需要在调用返回前完成持久化或自行复制。

`WALSource` 必须只输出已提交事务、按唯一 `LSN` 严格递增的变更。source 可以包含 `<= from` 的 record，协调器会按 checkpoint 跳过。

## 验证

```sh
go test -race ./...
go vet ./...
```

测试覆盖：快照重复/冲突、LSN 去重、旧 relation tuple、DDL 版本切换、sink 失败不推进 flush、快照中崩溃、WAL 确认后 checkpoint 前崩溃、跨事务 batch 恢复、文件 checkpoint 校验和与原子替换。
