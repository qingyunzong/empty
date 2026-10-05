# cutcli — 整数长度原材切割优化 CLI

把整数长度的原材切成需求件：每刀有固定损耗（kerf），余料低于门槛即报废，
否则作为带稳定 ID 的可复用余料跨订单保留。目标为字典序最小化
**(采购费, 报废量)**；切割次数按单价计入总费用并输出。

## 模型约定

- 每切一件消耗 `件长 + kerf`；一根原材装件 `p1..pk` 需满足
  `sum(pi) + k*kerf <= 原材长`，余料 = 剩余长度。
- 余料 `< scrapThreshold` → 报废；`>= scrapThreshold` → 入库复用（ID = 母材ID + `-L`，
  谱系可多级，如 `O1-P2-L <- O1-P2`）。
- 每件计一刀，切割费 = 件数 × `cutCost`（对所有方案为常数，仍计入预算与上下界）。
- 已切件不可回滚：需求更正 = 用当前库存余料 + 最小追加采购求解新增需求。
- 规模限制：单订单至多 16 件、8 根原材（超出返回错误）。

## 用法

```sh
go build -o cutcli .
cutcli solve     -job order.json [-state state.json]   # 最优切割计划(JSON)，并更新库存
cutcli bounds    -job order.json [-state state.json]   # 仅输出预算上下界
cutcli inventory -state state.json                     # 查看当前可复用余料
```

`-job -` 从标准输入读取。带 `-state` 时，订单消耗库存余料、新余料写回，
订单号缺省为 `O<seq>`。

## 输出要点

- `bars[].cuts`：每根原材的切割次序；`leftoverState` 为 `none/scrap/reusable`。
- `pieces[].source`：每件来源树（沿 parentId 回溯到原始采购材）。
- `totals.conservationOk`：全量长度守恒校验
  `总原材长 = 件长合计 + 锯缝损耗 + 报废 + 可复用余料`（每根同样成立）。
- `bounds`：预算上下界。下界 = 长度覆盖下界 × 最低单位长度价格 + 切割费；
  上界 = 首次适配递减贪心可行解。

## 正确性核对

`cut.BruteForce` 用独立实现（集合划分枚举 + 槽位-资源精确匹配）对小实例穷举，
测试中以 1000 个随机小实例与分支限界求解器逐一比对 `(采购费, 报废量)` 最优值，
并校验守恒与上下界夹逼。运行：

```sh
go test ./...
```
