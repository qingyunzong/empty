# kvmerge — 多版本键值段合并器

面向 LSM 树的段合并器，仅使用 Go 标准库。

## 功能

- **多版本值与墓碑**：每个键可含多个按序号（Seq）版本化的写操作，
  删除以墓碑（`Entry.Del`）表示。
- **快照感知的保留策略**：快照读者可注册在任意序号（`Registry`），
  合并时保留每个已注册读者可见的版本（最新读 + 每个快照序号处的
  可见版本），其余版本丢弃。
- **墓碑安全删除**：墓碑只有在压缩到最底层（`bottomMost=true`）且
  没有任何读者可见更旧版本时才删除——否则下层旧值可能复活。
- **去留原因输出**：`Result.Decisions` 覆盖每个输入条目，说明保留
  或丢弃的具体原因。
- **读模型对照**：`Store` 为未压缩读模型基准，测试将压缩结果与其
  在所有键 × 所有读者序号上逐一比对。

## 结构

- `merge.go` — 合并器核心（`Merge`、`Entry`、`Segment`、`Decision`）
- `model.go` — 未压缩读模型 `Store` 与压缩输出 `Result.Get`
- `registry.go` — 快照读者注册表 `Registry`
- `workload.go` — 随机分层数据生成器 `GenWorkload`
- `merge_test.go` — 单元测试（墓碑保留/删除、快照可见性、原因非空）
- `random_test.go` — 随机分层数据下全量/部分压缩与未压缩模型对照
- `cmd/kvmerge-demo` — 演示：打印每条目的去留原因并做读模型对照

## 运行

```sh
go test ./...          # 运行全部测试
go run ./cmd/kvmerge-demo -seed 42 -bottom=true   # 演示合并与对照
```
