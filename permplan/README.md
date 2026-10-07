# permplan — 权限规划 CLI

从至多 22 条允许规则中选出覆盖动作需求的**最小费用**规则集，并给出
需求分配方案。任何覆盖禁动作的规则不可选；同费用时按规则 ID 字典序
取最优。仅使用 Go 标准库。

## 构建与测试

```sh
go build ./...
go test ./...
```

## 用法

```sh
permplan solve  -in instance.json [-out cert.json]   # 求解并输出证书
permplan verify -in instance.json -cert cert.json    # 独立校验证书
```

## 输入格式（instance.json）

```json
{
  "rules": [
    {"id": "reader", "cost": 3, "use_cost": 0, "capacity": 0,
     "actions": {"read": 3}}
  ],
  "mutex": [["writer", "admin"]],
  "prereqs": [{"rule": "auditor", "requires": "reader"}],
  "quota": 6,
  "demands": {"read": 2, "write": 2},
  "forbidden": ["delete"]
}
```

- `rules`：≤22 条。`cost` 为选中一次的固定费，`use_cost` 为每单位
  动作的使用费，`capacity` 为规则总用量上限（≤0 表示不限），
  `actions` 为各动作可服务次数上限。
- `mutex`：互斥规则对，不可同时选中。
- `prereqs`：启用前置，选 `rule` 必须同时选 `requires`（可传递）。
- `quota`：全局动作次数配额（总分配量上限，≤0 表示不限）。
- `demands`：可重复动作需求多重集（动作 → 需求次数）。
- `forbidden`：禁动作；任何覆盖禁动作的规则（及其前置链依赖者）
  在求解前被剔除并记入证书。

## 求解模型

总费用 = 选中规则固定费之和 + 各规则分配量 × 使用费之和。需求是
多重集而非集合：同一动作的每一单位都要被分配，受每规则每动作上限、
每规则容量与全局配额约束。求解器对规则子集做带剪枝的枚举
（互斥/前置/覆盖必要条件/固定费+使用费下界），对每个候选子集用
最小费用流求最优分配；同费用按排序后规则 ID 序列的字典序决胜。

## 输出证书（cert.json）

- `solution` / `rule_usage`：选中规则、每规则各动作用量与费用分解。
- `coverage`：需求覆盖证书——每个动作的需求量与已分配量。
- `forbidden_check`：禁动作检查证书——被剔除规则及原因。
- `dependency_check`：依赖证书——逐条前置与互斥约束的满足情况。
- `quota_check`：全局配额用量。
- `bounds`：预算上下界（松弛下界 + 贪心可行解上界）。
- `verification`：小子集枚举核对与小分配枚举验收——用独立的
  逐单位暴力枚举（子集枚举 × 分配枚举）复核最优费用与所选规则
  集合的分配费用（规模超过 16 规则或 16 需求单位时跳过并注明）。

`permplan verify` 重新独立校验证书：覆盖、禁动作剔除、前置/互斥、
配额、每规则上限与容量、费用分解与上下界一致性。
