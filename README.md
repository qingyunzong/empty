# flow

Go 网络流库（仅标准库）：维护非负整数容量的有向图，支持增删边与
LIFO 撤销，任意版本可查询最大流、逐边可行流与最小割证书。平行边以
唯一 ID 区分。

## API

- `New() *Graph`
- `(*Graph).AddEdge(id string, from, to int, cap int64) error` — 容量为负返回
  `ErrNegativeCap`，ID 重复报错
- `(*Graph).RemoveEdge(id string) error`
- `(*Graph).Undo() bool` — 撤销最近一次增/删
- `(*Graph).Edges() []Edge` — 当前版本边集（按 ID 排序）
- `(*Graph).MaxFlow(s, t int) Result` — Dinic 算法；`Result` 含
  `Value`（流值）、`Flow`（逐边流量，满足容量约束与流量守恒）、
  `Cut`（残量图中 s 可达点集，即最小割证书，割容量等于流值）

## 测试

`flow_test.go` 对每个版本做三重核对：

1. 可行性：逐边 `0 <= flow <= cap`，非源汇点流量守恒，流值等于源点净流出；
2. 证书：割含 s 不含 t，割容量 == 流值；
3. 小图枚举：枚举全部 s-t 割，最小割容量 == 计算所得最大流
   （含 200 组随机增/删/撤销操作序列，每步核对）。

## 实测结果

```
$ go test ./...
ok  	flow	0.106s

$ go test -race -count=3 ./...
ok  	flow	2.924s
```

（Go 1.27.1 linux/amd64，2026-10-05 实测，全部通过。）
