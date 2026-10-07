# cutcli — 整数长度原材切割 CLI

仅使用 Go 标准库。给定整数长度原材、刀缝损耗与需求件，求最优切割方案。

## 模型

- 每刀损耗 `kerf`；`k` 件恰好占满一根时需 `k-1` 刀，否则 `k` 刀（最后一刀分离余料，
  余料必须容得下该刀缝）。
- 余料长度 `< minRemnant` 报废；`>= minRemnant` 作为带稳定 ID 的余料入库存，跨订单保留。
- 每根原材至多 `maxPiecesPerBar` 件（默认 16），至多 `maxBars` 根（默认 8）。
- 切割次数按 `cutCost` 收费。
- 目标按字典序：**采购费 → 报废长度 → 切割费**。
- 精确分支限界求解（件数上限 64），库存余料按 0 成本参与但每根只能用一次。

## 用法

```
cutcli -spec order.json [-inv inventory.json] [-prev prev_plan.json] [-verify] [-out plan.json]
```

- `-inv`：库存文件（不存在则创建）。求解后自动消耗/新增余料，ID 稳定递增（`R0001`…）。
- `-prev`：需求更正模式。已切件不可回滚，自动计算剩余需求并求最小追加采购计划；
  多切的多余件作为 surplus 报告。
- `-verify`：对小实例枚举全部分配（集合划分）核对最优性。
- `-out`：把计划 JSON 写到文件（供 `-prev` 引用）。

spec 示例：

```json
{
  "kerf": 2, "minRemnant": 6, "cutCost": 1,
  "stockTypes": [{"length": 30, "cost": 40}, {"length": 18, "cost": 26}],
  "demands": [{"length": 9, "count": 3}, {"length": 7, "count": 2}]
}
```

## 输出

- 每根原材的切割次序（`cut 1: P1 len 9` …）、刀数、刀缝损耗、余料/报废。
- 每件来源树：件 ← 原材 ←（余料时）来源链 `remnant of NEW-3 (order o1)`。
- 全量长度守恒：`stock = demand + kerf + remnant + scrap`，逐根与总计均校验。
- 预算上下界：采购下界 = `ceil((需求总长 - 余料容量) / 最大可购长度) * 最低单价`；
  刀数下界 = `件数 - min(件数, 最大根数)`；上界为实际方案。

## 测试

```
go test ./...
```

实际运行结果（2026-10-07，go1.27.1 linux/amd64）：

```
ok  	cutcli	0.004s
ok  	cutcli/cutting	0.017s
```

覆盖：已知最优解、恰好占满省一刀、报废门槛、余料跨订单复用（稳定 ID）、
需求更正（最小追加 + surplus）、根数/件数限制与不可行实例、
300 个随机小实例与穷举枚举逐一核对（目标值、守恒、上下界）。
