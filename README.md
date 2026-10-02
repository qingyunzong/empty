# offline-job-planner

离线作业筛选与 top-k 选择：Node.js 22、仅标准库、`node:test`、单机离线。

## 规则定义

- **分词**：说明按空白切分为词元。
- **短语过滤**：说明须含连续短语 `低温 固化`。
- **邻近过滤**：材料码与设备码须作为词元出现在说明中，且两者之间相隔词数 ≤ 6（`gap = |posM - posE| - 1`）。
- **命中数 hits**：短语出现次数 + 材料码出现次数 + 设备码出现次数。
- **得分**：`score = hits * 10 - overdue`（overdue 为录入时的超期天数）。
- **选择**：在 eligible 作业中枚举大小 1..k 的子集，总成本 ≤ 预算（硬约束），
  最大化总分；并列时剩余预算多者优先；再并列按作业 ID 升序排列，**返回全部并列最优**。
- **状态**：`EMPTY`（无任何通过过滤的作业）与 `OVER_BUDGET`（有合格作业但全部超预算）严格区分。

## 架构

- **字段化位置索引**（`src/planner.js`）：`descIndex`（词元 → 作业 → 位置）、
  `materialIndex` / `equipmentIndex`（码 → 作业集合）。候选仅由倒排索引产生。
- **独立线性扫描**（`linearScan`）：不触碰索引，直接重扫原始说明做精确校验；
  只有索引候选且扫描通过的作业才进入选择。
- **作废/恢复**：`voidJob` 立即把作业从候选过滤（索引保留），`restoreJob` 恢复；
  全部操作写入带序号的审计日志，`explain` 可查询。
- **explain**：对每个作业给出 `sources.invertedIndex`（倒排命中与候选集）与
  `sources.linearScan`（扫描位置、最小间距）两个来源及最终判定。

## 错误码

- `E_LIMIT`：k 越界（1..10）、预算为负、成本/超期非法、eligible 超过枚举上限 20。
- `E_TIE`：`select --one` 要求唯一最优但存在多个并列最优。
- `E_STATE`：重复 add、重复 void、恢复未作废作业、未知作业 ID。

## CLI

```sh
node cli.js add --id J1 --desc "低温 固化 使用 MAT1 于 EQ1" --material MAT1 --equipment EQ1 --cost 5 --overdue 0
node cli.js void --id J1
node cli.js restore --id J1
node cli.js select --material MAT1 --equipment EQ1 --k 2 --budget 10 [--one]
node cli.js explain --id J1 --material MAT1 --equipment EQ1
```

状态持久化到 JSON 文件（`--db` 指定，默认 `./planner-db.json`，可用 `PLANNER_DB` 覆盖）。
错误以 `{"error":{"code","message"}}` 输出到 stderr，退出码 1；用法错误退出码 2。

## 测试

```sh
node --test
```

验收覆盖：1) 随机数据集上与独立递归子集枚举对拍 top-k 与全部并列；2) 预算差 1 边界
（cost == budget 可行、cost == budget+1 不可行）；3) void 后 select 排除、restore 恢复、
explain 给出倒排/扫描来源；4) EMPTY 与 OVER_BUDGET 状态区分；另含 E_LIMIT/E_TIE/E_STATE
与 CLI 持久化往返测试。
