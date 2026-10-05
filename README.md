# permplan — 权限规划 CLI

从至多 22 条允许规则中选出**最小费用**的规则集，覆盖一个**可重复动作需求多重集**，
并把每个需求单元分配到具体规则。任何覆盖禁动作的规则一律不可选；等费最优解按
规则 ID 字典序取最小。只使用 Go 标准库。

## 构建与运行

```sh
go build -o permplan .
./permplan -in examples/sample.json            # 或: cat spec.json | ./permplan
./permplan -in spec.json -out report.json
```

## 输入（JSON）

```json
{
  "forbidden": ["delete"],
  "demands": {"read": 3, "write": 2},
  "globalQuota": 6,
  "rules": [
    {"id": "r1", "cost": 2, "actions": ["read"], "capacity": 2,
     "requires": ["r0"], "excludes": ["r2"]}
  ]
}
```

- `rules[].capacity`：单规则可承接的动作次数上限，`0` 表示不限。
- `rules[].requires`：启用前置，选中该规则必须同时选中前置（可传递、可成环）。
- `rules[].excludes`：互斥（对称）。
- `globalQuota`：全局动作次数配额，`0` 表示不限。
- 校验：≤22 条规则、ID 唯一、费用/容量/配额非负、引用存在、未知字段拒绝。

## 输出（JSON 报告）

- `status` / `cost` / `selectedRules`：`optimal` 或 `infeasible`，及最优费用与选中规则。
- `assignments` / `ruleUsage`：需求单元到规则的分配与每规则用量（非纯集合覆盖，
  需求是多重集，容量约束由最大流判定）。
- `certificates`：
  - `forbidden`：每条规则覆盖的禁动作与拒绝标记（禁动作检查证书）；
  - `coverage`：每个需求动作的需求量/已分配量/按规则分解（需求覆盖证书）；
  - `dependencies` / `exclusions`：前置满足与互斥未同选（依赖证书）；
  - `quota` / `capacities`：全局配额与单规则容量用量。
- `bounds`：松弛下界（逐动作最便宜规则的最大值）、贪心启发式上界、精确最优值。
- `verification`：
  - `subsets`：对全部 2^m 个合格规则子集的独立穷举核对（小子集枚举），
    与分支定界求解器结果比对；
  - `assignments`：对最优子集的需求单元分配做暴力枚举验收（小分配枚举，
    需求单元 ≤12 时执行），并与流式分配一致性核对、直接校验求解器分配。

## 方法

- 求解：按费用排序的分支定界，覆盖/容量后缀和剪枝；叶节点用 Dinic 最大流
  判定多重集需求在容量约束下的可分配性；等费按排序 ID 列表字典序取最小。
- 验证：独立的全子集枚举（流量调用有预算上限，超出则标记 `completed=false`）
  与分配枚举（节点/计数预算保护）。

## 测试

`go test ./...` 实际运行结果（Go 1.27.1，linux/amd64）：

```
ok      permplan        0.012s
ok      permplan/planner        0.136s
```

17 个测试全部通过（含 300 例随机实例的求解器/枚举一致性、禁动作拒绝、
互斥、前置、配额、并列 ID 序、多重集容量、22 规则上限等）；`go test -race`
同样通过。
