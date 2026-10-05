# routeinsert

配送库单车固定服务次序下的新订单（取送对）最优插入，纯 Go 标准库实现。

## 问题定义

- 车辆按固定次序服务已有停点（至多 `MaxOldStops = 20` 个），旧次序不得改变。
- 新订单含一个取货点（`Demand > 0`）和一个送货点（`Demand < 0`），可插入序列任意空隙。
- 约束规则：
  - `pickup_before_delivery`：取货必须先于送货（枚举时结构性保证，仅生成 i <= j 的候选）；
  - `capacity`：任意时刻车载量不超过容量、不为负；
  - `time_window`：到达晚于 `Due` 即违反，早于 `Ready` 允许等待。
- 目标：在所有可行插入位置中使额外里程最小。

## 实现

- `Problem.BestInsertion`：枚举全部插入空隙对 (i, j)，用局部边变化增量计算额外里程，路径仿真检查可行性；无解时返回所有候选违反规则的并集（排序后的 `ViolatedRules`）。
- `Problem.BruteForceAll`：独立参考实现，完整重建每条候选路径并重算全长，用于核对。

## 测试

`insertion/insertion_test.go` 包含：

- 旧次序保持、取送先后、容量空隙选择、等待时间窗等定向用例；
- 仅容量不可行、仅时间窗不可行、多规则同时不可行的违反规则集合断言；
- `TestCrossCheckAgainstBruteForce`：固定种子随机生成 2000 个实例（旧停点 0–20 个），
  逐一核对 `BestInsertion` 与 `BruteForceAll` 的可行性、最优额外里程及违反规则集合完全一致。

## 实际运行结果

```
$ go test ./...
ok  	routeinsert/insertion	1.732s
```

（10 个测试全部通过；`go vet ./...` 与 `gofmt -l .` 均无问题。）
