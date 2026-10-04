# 测试运行记录

## `go test ./...` 实际结果

运行时间：2026-10-05（Asia/Shanghai）

```
$ go test ./...
/bin/bash: line 1: go: command not found
exit=127
```

**结果：测试未能在本环境执行。** 本机未安装 Go 工具链
（`go`、`gofmt`、`gccgo`、`tinygo` 均不存在，无 docker/gcc），
且网络受限（DNS 解析失败，无法通过 apt 或 go.dev 下载工具链）。

在有 Go 工具链的环境中，于本目录执行以下命令即可复现：

```sh
go test ./...        # 单元测试 + 随机对照测试（80 个种子用例）
go test ./... -v     # 查看每个种子的输入/保留条目数与快照列表
go run ./cmd/kvmerge-demo -seed 42 -bottom=true
```

## 补充验证（算法级，非 `go test` 替代品）

由于无法本地编译，合并算法（与 `merge.go` 中 `mergeKey` 完全相同的
保留/墓碑删除规则）先用 Python 移植并做了随机模糊验证：

- 3000 组随机分层工作负载（随机键数 1~6、操作数 1~120、随机写/删、
  随机切分 1~5 层、随机注册 0~4 个快照读者）；
- 全量压缩（bottomMost=true）与部分压缩（bottomMost=false，合并
  部分层、其余层保持未压缩）两种模式；
- 对每个键 × 每个已注册快照序号及最新读，逐一比对压缩读模型与
  未压缩读模型；
- **结果：0 处不一致**（`done, fails = 0`）。

Go 测试文件 `random_test.go` 内置了等价的对照逻辑
（`TestRandomizedFullCompaction` 40 个种子、
`TestRandomizedPartialCompaction` 40 个种子），待有工具链后
直接由 `go test ./...` 执行。
