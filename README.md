# recipe-guard

精细化工离线终端的配方版本与审批链解释器。Node.js 22、仅标准库、`node:test`、单机离线。

操作工只能按审批链执行投料；解释器判定每次投料是否越权或触发危险组合，
输出 `allow.jsonl` 与 `proof/` 证明目录，支持按釜重放审计与最小反例分析。

## 用法

```sh
node cli.js run  --recipes R.json --approvals A.jsonl --attempts T.jsonl --out allow.jsonl --proof DIR
node cli.js audit --recipes R.json --approvals A.jsonl --attempts T.jsonl --allow allow.jsonl --proof DIR
node cli.js counterexample --recipes R.json --approvals A.jsonl --attempts T.jsonl [--attempt ID]
node --test   # 全部测试
```

退出码：`0` 正常；`1` 审计不一致；`2` 输入非法；`16` 版本回退；`17` 审批链断裂；`18` 禁配表循环。

## 输入格式

`recipes.json`：

```json
{
  "plant": { "factories": [ { "id": "F1", "workshops": [ { "id": "W1", "kettles": ["K1"] } ] } ] },
  "versions": [ {"id": "v1", "seq": 1}, {"id": "v2", "seq": 2} ],
  "forbiddenGroups": { "oxidizers": ["v2"] },
  "forbidden": [ {"pair": ["v1", "@oxidizers"]} ]
}
```

- `seq` 单调递增表示版本新旧；同釜内投入 `seq` 更低的版本即版本回退（exit 16）。
- `forbidden` 为“禁止同釜”版本对；可用 `@组名` 引用 `forbiddenGroups`，
  组可嵌套引用，组引用成环即禁配表循环（exit 18）。

`approvals.jsonl`（每行一条）：

```json
{"id":"a1","kind":"grant","level":"factory","target":"F1","version":"*","operator":"*","ts":1}
{"id":"a2","kind":"deny","level":"workshop","target":"W1","version":"v2","ts":2}
{"id":"a3","kind":"grant","level":"kettle","target":"K1","version":"v2","parent":"a1","ts":3}
{"id":"r1","kind":"revoke","revokes":"a1","reason":"supplier lot recalled","ts":8}
```

- `version` / `operator` 省略或为 `"*"` 表示通配。
- `parent` 可选，指向上级 grant；引用缺失、指向非 grant、层级不倒置或
  目标非祖先，均为审批链断裂（exit 17）。revoke 指向不存在的审批同为 exit 17。

`attempts.jsonl`：`{"id":"t1","kettle":"K1","version":"v2","operator":"op1","ts":4}`。

## 判定语义

- **继承**：审批沿 工厂→车间→釜 继承；按 釜→车间→工厂 就近求值，
  最近一层的任何 deny 截断上层继承（deny 优先于同层 grant）。
- **约束胜**：禁配约束优先于放行权限——即使审批有效，与同釜已投版本
  构成禁配对的投料一律拒绝。
- **撤销**：`revoke` 可带 `reason`；撤销前已发生的投料不抹除，
  生成偏差记录写入 `proof/deviations.json`，撤销时点之后的投料失去依据。
- **时间**：审批/撤销均按 `ts` 生效；投料按 `(ts, id)` 排序判定。

## 输出

- `allow.jsonl`：每次投料的判定、理由与见证审批。
- `proof/kettle-<釜>.json`：按釜重放证明——每次投料列出见证审批、
  当时釜内已有版本及禁配核对结果。
- `proof/deviations.json`：撤销引发的偏差记录（历史投料保留）。
- `proof/counterexample.json`：对每个被禁配拦截的投料，给出会使其被
  错误放行的最小审批集合（仅看权限层、忽略禁配约束）。
- `audit` 子命令重放全部输入并逐字节核对 `allow.jsonl` 与证明目录，
  不一致即 exit 1。

## 结构

- `src/plant.js` 层级与祖先链；`src/recipes.js` 配方/禁配表校验（exit 18）
- `src/approvals.js` 审批链校验（exit 17）；`src/interpreter.js` 判定器
- `src/brute.js` 全展开参考实现（验收 D 对照）；`src/audit.js` 重放/偏差/证明
- `src/counterexample.js` 最小反例集合；`cli.js` 命令行入口
