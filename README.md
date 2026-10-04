# pagesnap — 支持分叉快照与写时复制的内存页库

纯 Go 标准库实现。核心语义：

- **分叉快照**：`Snapshot.Fork()` 以 O(页数) 建立新分支，只复制逻辑→物理页映射并递增引用计数，不复制页数据。
- **写时复制（COW）**：写入被多个分支共享的物理页时自动复制私有副本，同页多分支修改互不影响。
- **精确引用计数**：分叉 +1、关闭分支 -1，计数归零才回收物理页；旧视图仍存活时页绝不回收。
- **可诊断**：`Store.Stats()`、`Store.RefTable()`、`Store.VerifyRefCounts()` 随时校验引用表与活快照映射完全一致。

## 布局

| 路径 | 说明 |
| --- | --- |
| `pagesnap.go` | 核心库：`Store` / `Snapshot` / COW / 引用计数 |
| `model/` | 深复制参考模型（每次分叉整页拷贝），用于对照 |
| `workload/` | 随机分叉历史生成器：同一操作序列同时驱动 COW 库与深复制模型，逐读比对 |
| `cmd/pagediag/` | 诊断 CLI |
| `pagesnap_test.go`, `workload/workload_test.go` | 单元测试 + 25 个种子的随机历史对照测试 |

## 测试

```sh
go test ./...
```

## 诊断 CLI

```sh
# 随机分叉历史 vs 深复制模型，结束后要求全部页回收
go run ./cmd/pagediag run -seed 1 -ops 5000 -snaps 16 -pages 64

# 保留最终快照，转储存活物理页引用表并校验不变量
go run ./cmd/pagediag refs -seed 7 -ops 3000
```

发散或引用计数违规时以非零码退出；相同 seed 完全可复现。
