# offline-planner

离线作业筛选与 top-k 选择（Node.js 22，仅标准库，无外部依赖）。

## 规则约定

- **分词**：说明按空白切分，词位置为下标（`src/tokenize.js`）。
- **匹配条件**（`src/verify.js`，独立线性扫描，不复用索引位置）：
  1. 短语 `低温 固化` 作为相邻词出现；
  2. 材料码与设备码均出现，且存在一对位置距离 `|posA - posB| <= 6`。
- **命中数** = 短语出现次数 + 合格（材料码, 设备码）邻近对数；**得分 = 命中数 * 10 - 超期**。
- **索引**：字段化位置倒排（field -> term -> docId -> [positions]），候选由倒排交集产生，再经线性扫描精确校验（`src/index.js`、`src/planner.js`）。
- **选择**（`src/select.js`）：枚举所有非空子集（大小 ≤ k，总成本 ≤ 预算，预算为硬约束），最大化总得分；得分并列时取剩余预算最大（成本最小）；仍并列的子集**全部返回**，每个子集内及子集间均按作业 ID 升序。候选数超过 20 报 `E_LIMIT`（精确枚举上限）。
- **状态**：`EMPTY`（无候选）与 `OVER_BUDGET`（有候选但全部超预算）区分；`OK` 唯一最优；`TIE` 多个并列最优（全部返回）。
- **作废/恢复**：作废立即从候选过滤，作业与审计日志（add/void/restore）保留在存储中。

## CLI

```
node bin/cli.js [--store PATH] <command>
  add     --id ID --desc TEXT --material CODE --equipment CODE --cost N --overdue N
  void    --id ID
  restore --id ID
  select  --k N --budget N [--one]
  explain --id ID
```

- 存储路径：`--store` > 环境变量 `PLANNER_STORE` > `./planner-store.json`。
- `select` 默认列出全部并列最优；`--one` 要求唯一最优，并列时报 `E_TIE`。
- `explain` 给出来源标注：候选来自 `倒排 inverted-index`，精确校验来自 `扫描 linear-scan`，并附审计记录。

## 错误码

- `E_LIMIT`：参数/上限错误（k、budget、cost 非法，候选超枚举上限，缺字段等）。
- `E_TIE`：`--one` 下存在多个并列最优。
- `E_STATE`：状态错误（重复 add、作废不存在/已作废、恢复未作废等）。

## 测试

```
node --test
```

验收覆盖：1) 随机用例与递归全子集枚举对拍 top-k 与并列；2) 预算差 1 边界（49 超预算 / 50 可选）；3) void 后 select 排除、restore 恢复、explain 标注倒排/扫描来源；4) `EMPTY` 与 `OVER_BUDGET` 状态区分。
