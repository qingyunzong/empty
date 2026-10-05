# berthsched — 泊位排程 CLI

为至多 12 艘船在**单个长度受限泊位**上选择离散候选开始时刻，目标优先最小化总等待时间（次目标最小化完工时间 makespan）。

## 模型

- 时间一律使用**绝对分钟**（从第 0 天 00:00 起算），因此船舶可**跨午夜**占用泊位（如 `[1380, 1560)`）。
- 每艘船：长度、到港时刻、服务时长；可选显式候选开始时刻 `starts`。
- 未显式给定时，候选开始时刻由潮汐窗口按 `step` 网格生成：`start >= arrival` 且整个服务区间 `[start, start+duration)` 完整落在某一个潮汐窗口内。
- 泊位容量：任意时刻同时停靠船舶的长度之和不得超过 `berth_length`。
- 占用输出为**半开区间** `[start, end)`，因此一艘船结束与下一艘船开始可以共用同一时刻。

## 用法

```sh
go run . -i examples/problem.json            # 文本输出
go run . -i examples/problem.json -json      # JSON 输出
go run . -i examples/problem.json -brute     # 附带全枚举对照
cat examples/problem.json | go run .         # 从 stdin 读取
```

## 求解与对照

- `Solve`：按候选数最少优先排序的深度优先分支定界，以下界（当前等待 + 剩余船最小等待和）剪枝，增量检查泊位长度容量。
- `BruteForce`：对所有船候选时刻的笛卡尔积做**全枚举**，作为小规模实例的真值对照；测试中以随机实例交叉验证两者目标值一致。

## 测试

```sh
go test ./...
```
