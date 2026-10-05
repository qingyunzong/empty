# router — 有限状态图最低费用路由 CLI

仅使用 Go 标准库。在有限状态图上求从起点到终点的最低费用路线，输出逐步
状态证书与最优费用下界，并带独立搜索对照。

## 模型

- **状态**：`(节点, 剩余整数油量, 一次性优惠位掩码, 各补给站剩余充电位, 时间)`
- **上限**：节点 ≤ 10，油量 ≤ 20，优惠 6 张（位掩码），补给站 ≤ 4 个、
  每站充电位 ≤ 3，时间 ≤ 60
- **通行费**：`toll = 基础费 + (最大油量 - 当前油量)/2`（低油附加费，依赖
  剩余整数燃料，非负）；使用优惠券再减折扣，下限为 0
- **一次性优惠**：6 张券以位掩码跟踪，使用后清零——同一张券在返程
  （或任何后续路段）不可再用
- **路段时窗**：边的完整通行区间 `[出发, 出发+耗时]` 必须落在某个开放
  时窗内；允许在节点等待（自动取最早可行出发时刻）
- **充电位容量**：补给站每次加油动作消耗 1 个充电位，容量随状态递减
- **非负费用**：所有转移费用 ≥ 0，Dijkstra 最优性成立

## 求解与对照

- 主求解器：时间扩展状态图上的 Dijkstra + 精确支配剪枝（同节点下，
  油量 ≥、优惠券为超集、各站充电位 ≥、时间 ≤、费用 ≤ 的状态支配被剪状态；
  因低油附加费随油量单调不增且允许等待，剪枝精确）
- 独立对照 1：关闭剪枝的 Dijkstra（`-no-prune`）
- 独立对照 2：纯深度优先穷举（`exhaustive`，无剪枝无备忘；所有转移严格
  增加时间，状态图无环，枚举必然终止）
- 微小网格测试（1x2/2x2/2x3/3x3）三方对照，验证剪枝不漏可行路线

## 暂停与恢复

`solve -max-steps N -checkpoint cp.json` 在展开 N 个状态后暂停，把完整
搜索前沿（优先队列、最优费用表、已 settle 集合、父指针、步数）序列化为
JSON；`-resume cp.json` 恢复后继续，结果与不中断运行一致（有测试保证）。

## 证书

证书含逐步状态转移（动作、边/站、用券、费用、累计）与最优费用下界。
`verify` 独立重放：逐步重算合法转移与费用，并用重新求解确认最优性。

## 用法

```sh
go build -o router .
./router gen -nodes 6 -seed 1 -out g.json        # 生成随机实例（支持 -grid 2x3）
./router solve -graph g.json -cert cert.json     # 求解并输出状态转移与下界
./router verify -graph g.json -cert cert.json    # 重放证书并确认最优
./router exhaustive -graph g.json                # 独立穷举对照
./router solve -graph g.json -max-steps 5 -checkpoint cp.json   # 暂停
./router solve -graph g.json -resume cp.json                    # 恢复
```

示例：`examples/sample.json` 最优费用 16（证书
`examples/sample.cert.json`），与穷举对照一致。

## 测试结果（实际运行记录）

```
$ go test ./...
ok  	router	0.256s
```

15 个测试全部通过（Go 1.27.1, linux/amd64）：

- `TestCrossCheckRandom` / `TestCrossCheckTinyGrids`：150 个随机小实例 +
  160 个微小网格实例，剪枝 Dijkstra = 无剪枝 Dijkstra = 纯穷举
- `TestCheckpointResume`：每 7 步暂停/序列化/恢复，结果与单次运行一致
- `TestCertificateVerify` / `TestCertificateTamper` /
  `TestCertificateDeterminism`：证书重放、篡改拒绝、确定性
- `TestCouponSingleUseOnReturn`：同一张优惠券返程不可再用
- `TestWindowClosedEdge` / `TestWindowWaiting`：时窗关闭绕行、等窗
- `TestStationChargingSlots` / `TestRefuelSlotConsumed`：充电位容量约束
- `TestTimeHorizon`：时间上限 60
- `TestNonNegativeCosts` / `TestTollDependsOnRemainingFuel`：费用非负、
  通行费随剩余整数燃料变化
- `TestPruningReducesWork`：剪枝不多于无剪枝展开数
