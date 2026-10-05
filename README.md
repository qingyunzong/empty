# pagestore

内存页库：分叉快照 + 写时复制（copy-on-write）。仅使用 Go 标准库。

## 结构

- `cowpage` — 核心库。`Store` 管理物理页及引用计数；分支（branch）是逻辑页 → 物理页的快照表。
  - `Fork` 共享全部物理页并增加引用计数；任一分支写入共享页时先复制再写，多分支修改互不影响。
  - `Delete` 归还该分支的全部页引用；引用计数归零才回收物理页，旧视图存活期间页不会被回收。
  - `Validate` 校验引用计数不变量（每物理页计数 == 各分支表项引用之和 + 存储持有的零页引用）。
  - 新建分支共享存储级零页；`Close` 释放零页引用后 `LivePages` 应归零（无泄漏）。
- `diag` — 诊断器：以可复现的随机种子生成分叉/写入/读取/删除历史，逐步与独立的深复制模型对照，并在每步校验引用计数不变量；结束时删除所有分支检查泄漏。
- `cmd/pagediag` — 诊断 CLI。

## 使用

```sh
go test ./...
go run ./cmd/pagediag -seed 20261005 -ops 20000 -pages 64 -page-size 4096 -max-branches 32
go run ./cmd/pagediag -v -ops 50   # 打印每个操作
```

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64。

```
$ go test ./...
?   	pagestore/cmd/pagediag	[no test files]
ok  	pagestore/cowpage	0.002s
ok  	pagestore/diag	0.267s
```

CLI 对照运行（20000 次随机操作，3913 次分叉，峰值 32 个并发分支 / 265 个活跃物理页）：

```
OK seed=20261005 ops=20000 forks=3913 writes=8137 reads=3964 deletes=3959 full-checks=16036 peak-branches=32 peak-live-pages=265
all views match deep-copy model; all page references returned; no leaks
```
