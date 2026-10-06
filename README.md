# berthsched — 泊位排程 CLI

为至多 12 艘船选择离散候选开始时刻，目标为**总等待时间最小**
（等待 = 开始时刻 − 到港时刻）。仅使用 Go 标准库。

## 模型

- 所有时间为**绝对分钟**，可超过 1440，船可跨午夜占用泊位。
- 占用区间为**半开区间** `[start, end)`：一艘船在 `t` 结束，另一艘可在 `t` 开始。
- 每艘船的整个占用区间必须完整落在其某一个**潮汐区间**内。
- 船长度不得超过所分配**泊位长度**。
- 开始时刻必须来自该船的离散候选集合，且不早于到港时刻。
- 目标：最小化总等待；并列时依次按总完工时刻、字典序取确定解。

## 用法

```sh
go build -o berthsched .
./berthsched -input examples/sample.json     # 分支定界（默认）
./berthsched -brute -input examples/sample.json
cat examples/sample.json | ./berthsched      #  stdin
```

输入 JSON：

```json
{
  "berths": [{"id": "B1", "length": 300}],
  "ships": [{
    "id": "S1", "length": 220, "arrival": 1320, "duration": 180,
    "tidal_windows": [{"start": 1200, "end": 1560}],
    "candidates": [1320, 1380]
  }]
}
```

输出 JSON：`total_wait`、`total_end` 及每艘船的
`{ship, berth, start, end}`（半开占用 `[start, end)`）。

## 求解器

- `solveExact`（`schedule.go`）：按可行开始数排序的 DFS + 分支定界，
  下界为剩余船最小等待的后缀和。
- `solveBrute`（`brute.go`）：无任何剪枝的全枚举，作为小规模对照。
- `ValidateSolution`：独立校验半开占用、潮汐包含、泊位长度、
  候选时刻与无重叠。

## 测试结果（实际运行记录）

```
$ go test ./...
ok  	berthsched	13.679s
```

覆盖：半开相邻、跨午夜绝对时间、潮汐区间包含、泊位长度约束、
不可行判定、非法输入、300 个随机小实例上分支定界 vs 全枚举
目标值一致性（含不可行一致性）、12 船规模性能（约 2 ms）、
CLI 端到端 JSON 输入输出。
