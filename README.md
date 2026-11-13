# Iceberg manifest 合并与删除规划

`dataeng` 是一个可导入的 Go 库，供湖仓扫描规划器使用。它把 snapshot
lineage、data file、position delete、deletion vector 和 equality delete
绑定到正确的 data sequence number，并生成可直接读取的
`FileScanTask` 列表。

## 快速使用

```go
table := dataeng.NewTable()
table.AddPartitionSpec(dataeng.PartitionSpec{
    SpecID: 0,
    Fields: []dataeng.PartitionField{{
        SourceID: 1, FieldID: 1000, Name: "region",
        Transform: dataeng.TransformIdentity,
    }},
})
table.AddSnapshot(dataeng.Snapshot{
    SnapshotID:     1,
    SequenceNumber: 1,
    Manifests: []dataeng.ManifestFile{{
        ManifestPath:    "metadata/data.avro",
        PartitionSpecID: 0,
        Content:         dataeng.ManifestContentData,
        SequenceNumber:  1,
        Entries: []dataeng.ManifestEntry{{
            Status:   dataeng.EntryStatusAdded,
            DataFile: dataeng.NewDataFile("data/us.parquet", 0,
                dataeng.Partition{"region": "us"}),
        }},
    }},
})
_ = table.SetCurrentSnapshot(1)

plan, err := dataeng.NewPlanner(table).
    PlanCurrent(dataeng.PartitionEquals("region", "us"))
```

`ManifestFile.Entries` 可以直接内嵌，也可以通过 `ManifestLoader` 从 Avro
manifest 读取；manifest list 可通过 `ManifestListLoader` 延迟读取。

## 关键规则

- **sequence 继承**：entry 的 sequence 为空或 `-1` 时继承 manifest 的
  sequence；改写 manifest 时 `EXISTING` 文件保留原 sequence。data sequence
  与 file sequence 独立解析。
- **删除适用性**：position delete 与 deletion vector 作用于
  `dataSequence <= deleteSequence` 的数据；equality delete 只作用于
  `dataSequence < deleteSequence` 的数据。因此同一 commit 内的 position
  delete 可以删除新写入行，equality delete 不会误删同 commit 的新行。
- **分区裁剪安全**：查询谓词只裁剪 data file。所有 live delete file 都保留
  在 `ScanPlan.DeleteFiles` 中，再按 sequence、文件作用域和分区规格绑定；
  分区规格不同或 delete 未分区时采用保守的 may-match 判断，绝不因裁剪
  丢失可能的删除。
- **回滚隔离**：`RollbackToSnapshot` / `RollbackToTimestamp` 只改变
  current snapshot。规划器只读取该快照自己的 manifest list，并用
  `snapshot.SequenceNumber` 截断 entry；即使 manifest 列表被错误合并，
  descendant manifest 也会被 lineage 校验排除。
- **逐行参照**：`ReferenceTable` 与 `ApplyReferenceDeletes` 用嵌套循环逐行
  应用删除，作为小表 oracle；`VerifyPlan` 将规划器绑定结果与 oracle 比较。

## 验证

```bash
go test ./...
go test -race ./...
```
