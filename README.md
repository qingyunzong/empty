# contractopt

合同优化库（仅使用 Go 标准库）。

## 模型

- 从候选合同中选择至多 20 份（`MaxSelect <= 20`）。
- 每份合同有收入 `Revenue`、工期 `Duration`、资源需求向量 `Demand`，
  以及若干候选开始时间段 `Starts`（选其一）。
- 资源上限为整数向量：每个时间段各有一份容量向量 `Capacity[period][resource]`，
  合同在其占据的每个时间段消耗资源。
- 前置合同公开：`Prereqs` 中的合同必须被选中且在前合同完结后本合同才能开始。
- 最多一选互斥公开：同一 `Group` 内至多选中一份。
- 已有合同锁定不可动：`Locked` 合同必须固定在 `Start` 开始。
- 目标：收益最大；并列时总资源占用更小者优先。

## 求解与证书

- `Solve` 返回最优解与依赖证书 `Certificate`：选中的合同、实际使用的前置边、
  占满的互斥组、饱和的 (时间段, 资源) 槽位、数量上限是否 binding、搜索节点数。
- `Certificate.Verify` 重算并核对证书中的每一项依赖。
- `Enumerate` / `VerifyOptimalByEnumeration` 枚举全部子集与开始段分配，
  在小实例上对照求解器结果。

## 修订后再优化

- `Reoptimize(in, old)`：实例中修订一份合同后，先最小化改动合同数
  （选择状态或开始段不同的合同数），再最大化收益、最小化资源占用。
- 返回旧/新分配与上下界证据：`ChangesLowerBound`（旧分配仍可行则为 0，否则为 1）、
  `RevenueLowerBound`（实际达成收益）、`RevenueUpperBound`（不限制改动数时的最优收益）。
- `EnumerateReopt` 在小实例上枚举验收再优化结果。

## 测试

```sh
go test ./...
```

包含手工用例（并列资源占用、前置时序、互斥、数量上限、锁定、不可行、
证书字段）与固定种子随机小实例对照（400 例求解 vs 枚举、400 例再优化 vs 枚举）。
