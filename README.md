# Iceberg 位置删除跨快照应用

`example.org/dataeng/q0203` 是一个可导入的零依赖 Go 库，用于在湖仓读取层规划
Iceberg position delete：

- 根据 data file 路径、零基行位置、delete file sequence number 和 snapshot
  lineage 计算删除计划。
- 删除文件只作用于 `data.sequence <= delete.sequence` 的数据文件，不会误删比
  自身更新的数据。
- 分支快照只遍历自己的祖先链，不会继承兄弟分支的删除文件。
- 同一路径的多个删除文件、重复位置会去重，并合并为按文件分组的有序半开区间
  `[Start, End)`。
- 内置逐行参考执行器，用于验证区间计划得到的可见记录与逐行应用完全一致。

## 导入

```go
import dataeng "example.org/dataeng/q0203"
```

## 快速开始

```go
dataFiles := []dataeng.DataFile{
    {Path: "s3://warehouse/data/a.parquet", SequenceNumber: 7, RowCount: 1000},
}

deleteFiles := []dataeng.DeleteFile{
    {
        Path:           "s3://warehouse/delete/d1.parquet",
        SequenceNumber: 8,
        Records: []dataeng.PositionDelete{
            {FilePath: "s3://warehouse/data/a.parquet", Position: 3},
            {FilePath: "s3://warehouse/data/a.parquet", Position: 4},
            {FilePath: "s3://warehouse/data/a.parquet", Position: 9},
        },
    },
}

plan, err := dataeng.PlanDeletes(dataFiles, deleteFiles)
if err != nil {
    log.Fatal(err)
}

for _, file := range plan.Files {
    fmt.Print(file.Path)
    for _, interval := range file.Intervals {
        fmt.Printf(" [%d,%d)", interval.Start, interval.End)
    }
    fmt.Println() // s3://warehouse/data/a.parquet [3,5) [9,10)
}
```

`PlanDeletes` 接收调用方已经解析好的可见删除文件集合，只应用路径和序列号规则。
如果删除文件在更早的 snapshot 中写入，应由调用方提供其实际 sequence number，而
不是当前 snapshot 的 sequence number。

## 快照与分支

```go
catalog, err := dataeng.NewCatalogWithBranches(
    []dataeng.Snapshot{
        {
            ID: 10, SequenceNumber: 1,
            DeleteFiles: []dataeng.DeleteFile{rootDelete},
        },
        {
            ID: 11, ParentID: 10, SequenceNumber: 2,
            DeleteFiles: []dataeng.DeleteFile{mainDelete},
        },
        {
            ID: 12, ParentID: 10, SequenceNumber: 2,
            DeleteFiles: []dataeng.DeleteFile{siblingDelete},
        },
    },
    map[string]int64{
        "main":    11,
        "sibling": 12,
    },
)
if err != nil {
    log.Fatal(err)
}

mainPlan, _ := catalog.PlanBranch("main", dataFiles)
siblingPlan, _ := catalog.PlanBranch("sibling", dataFiles)
```

`main` 的可见集合是 `rootDelete + mainDelete`，`sibling` 是
`rootDelete + siblingDelete`。两个分支互不影响。`Snapshot.RemovedDeleteFiles`
可以按路径隐藏祖先引入的删除文件；同一路径在后续 snapshot 重新加入后会再次可见。

`DeleteFile.SequenceNumber == 0` 时继承引入该文件的 snapshot sequence number。
`DeleteFile.SnapshotID == 0` 时自动填写为引入它的 snapshot ID。

## 路径身份

`CanonicalPath` 只做 RFC 3986 中不改变对象身份的规范化：

- URI scheme 和 host 转为小写；
- 非保留字符的百分号转义解码，其余转义统一大写。

以下内容全部原样保留，避免把不同对象合并：

- 路径大小写、末尾 `/`、连续 `//`、`.`/`..` 段；
- `%2F` 等保留字符转义；
- query、fragment；
- 普通本地路径和 Windows 盘符路径。

例如 `s3://bucket/data` 与 `s3://bucket/data/` 是两个不同的对象；
`s3://bucket/a/b` 与 `s3://bucket/a%2Fb` 也不会合并。

## 逐行参考验证

```go
rows := []dataeng.FileRows{
    {
        DataFile: dataFiles[0],
        Rows:     []dataeng.Row{{"r0"}, {"r1"}, {"r2"}, {"r3"}, {"r4"}},
    },
}

if err := dataeng.VerifyPlan(plan, rows, deleteFiles); err != nil {
    log.Fatal(err)
}

// 或者由 catalog 自动解析目标快照的可见删除集合：
if err := catalog.VerifySnapshotPlan(11, mainPlan, rows); err != nil {
    log.Fatal(err)
}
```

`ReferenceVisible` 不使用区间，而是逐行、逐删除记录判断 `file_path`、`position`
和 sequence number，因此可以作为计划执行结果的独立参考实现。

## 输出约定

- `Plan.Files` 默认只包含至少有一个删除位置的 data file；使用
  `dataeng.WithEmptyDataFiles()` 可输出全部扫描文件。
- `FilePlan.Intervals` 从 `Start` 升序排列、互不重叠，`End` 为开区间。
- 同一 canonical path 和 sequence number 的重复 data file 输入会去重；路径相同但
  sequence number 不同的条目保持独立。
- 规划器不依赖 `DataFile.RowCount`，也不会静默截断越界位置；越界位置不会影响
  逐行参考执行器的可见记录。

## 验证

```sh
go test ./...
go test -race ./...
go vet ./...
```
