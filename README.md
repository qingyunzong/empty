# recipe-terminal

精细化工离线终端：配方版本管理 + 审批链执行的投料解释器。Node.js 22、仅标准库、单机离线。

## 数据文件

- `recipes.json` — 工厂拓扑（factory → workshops → reactors）、配方版本表、有向禁配表
  （`["R1@1","R2@1"]` 表示：釜内已有 `R1@1` 时禁止再投 `R2@1`）。
- `approvals.jsonl` — 审批日志，每行一条，均带数值 `ts`：
  - `{"op":"grant","id":"a1","level":"factory|workshop|reactor","workshop"?,"reactor"?,"recipe","version"}`
  - `{"op":"deny", ...}` 同级字段，截断继承
  - `{"op":"revoke","target":"a1","reason":"..."}`
- `attempts.jsonl` — 操作日志：`{"op":"feed","reactor","recipe","version","ts"}` / `{"op":"empty","reactor","ts"}`

## 核心语义

- 审批权限沿 工厂→车间→釜 继承；最具体的有效规则胜出，同级取最新 `ts`；deny 截断继承。
- 车间级 grant 必须挂在有效工厂级 grant 上，釜级 grant 必须挂在有效车间级 grant 上，否则审批链断裂（exit 17）。
- 禁配约束永远胜过放行权限：有有效审批但触发禁配时仍 deny（`reason:"forbidden"`）。
- 撤销审批可带 `reason`；若该审批链下已有投料，生成偏差记录（`proof/deviations.jsonl`），历史不抹除。
- 撤销沿链级联（撤工厂级则下属车间/釜级一并失效）。
- 版本回退（recipes.json 版本非递增，或投料版本低于当前版本）exit 16；禁配表有向循环 exit 18。

## CLI

```sh
# 执行判定：产出 allow.jsonl 与 proof/ 目录（每釜重放文件、deviations.jsonl、summary.json）
node src/cli.js run --recipes recipes.json --approvals approvals.jsonl \
  --attempts attempts.jsonl --out allow.jsonl --proofdir proof

# 审计：按釜重放，独立复核每次 allow 都有有效审批且未触发禁配
node src/cli.js audit --recipes recipes.json --approvals approvals.jsonl \
  --attempts attempts.jsonl --reactor K1

# 反例：枚举最小审批集合，使某危险投料在权限层被错误允许（约束层仍会拦截）
node src/cli.js counterexample --recipes recipes.json --approvals approvals.jsonl \
  --attempts attempts.jsonl --reactor K1 --recipe R2 --version 1 --out proof/counterexample.json
```

退出码：`0` 正常；`16` 版本回退；`17` 审批链断裂；`18` 禁配表循环；`1` 其他输入错误；`2` 用法错误。

## 测试

```sh
node --test
```

验收覆盖：A 继承审批被车间 deny 截断；B 撤销后历史偏差保留；C 两版本同釜冲突（约束胜）；
D ≤8 审批/禁配的全子集枚举对照（解释器 vs 独立暴力规格三方核对、反例最小性枚举验证）。
