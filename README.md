# fsc-settle

财务共享中心多币种净额结算：把应收应付按**精确有理数汇率**折成记账本位币，
输出各主体净额、不可行证明（最小冲突子集证书）或最优（最小流量）净额解。
纯 Node.js 22 标准库，无第三方依赖，单机离线可运行。

## 快速开始

```bash
npm test            # 等价于 node --test
npm run example     # 等价于 bash examples/run.sh（端到端演示）
node src/cli.js settle examples/normal.jsonl --base CNY
node src/cli.js verify examples/conflict.jsonl cert.json
node src/cli.js hash examples/undo.jsonl
```

## 事件格式（JSONL，每行一个事件）

支持 `{"addInvoice":{...}}` 嵌套式或 `{"op":"addInvoice",...}` 平铺式。
每个事件按行号获得 `evt:<line>` 标识。

| 事件 | 字段 | 语义 |
| --- | --- | --- |
| `addInvoice` | `id, ccy, num, den` | 发票金额 `num/den`（正=应收，负=应付）；`id` 中 `:` 前缀为主体，如 `A:1` → 主体 `A` |
| `setRate` | `pair, num, den` | 汇率 `pair="USD/CNY"` 表示 `value(USD) = num/den * value(CNY)`，必须为正 |
| `correct` | `refId, newNum, newDen` | 更正发票金额或汇率；`refId` 可为发票 id、`evt:n` 或汇率对（取最近有效者） |
| `undo` | `eventId` | 撤销任意先前事件（含 correct/undo 自身，undo 的 undo 即恢复） |

`num/den` 接受整数、有限小数字符串（`"12.34"`）或分数（`"1/7"`），全部按精确有理数处理。

## 核心机制

- **精确有理数**：所有金额、汇率、比较均在 BigInt 有理数（最低项）上进行，全程无浮点。
- **汇率一致性**：每条 `setRate A/B=q` 是线性等式 `value(A)=q·value(B)`（两个半平面的交）。
  用带权并查集判定三角一致性；不一致时输出**最小冲突子集证书**——事件数 ≤16 时
  穷举子集取精确最小（`exact-minimum`），否则用删除过滤给出包含极小的矛盾环
  （`inclusion-minimal`）。证书含环上各事件、既有边蕴含比值、新边断言比值与环积。
- **独立复核**：`verify` 命令只信证书里的事件 id，从原始日志重新提取事件，
  独立检查：事件可解析、证书内引用的汇率与日志一致（防篡改）、子集不可行、
  且去掉任意一条即可行（极小性）。
- **增量历史哈希**：历史哈希是同态多重集哈希（LtHash 风格，
  `H = Σ sha256(canonical(event)) mod 2^256`）。`undo` 删一项、`correct` 换一项，
  均为 O(1)，**从不重算前缀**（`stats.hashRecomputations` 恒为 0，远低于 N=2000
  的全量重算上限）。`referenceHash()` 提供从头复核，测试断言二者恒等。
- **末位舍入**：舍入只发生在最终出账。银行家舍入（round-half-to-even），
  每个净额同时给出精确值、舍入值、精确误差 `roundingError` 与最坏误差界
  `errorBound = 1/(2·10^decimals)`。
- **净额即最优解**：净额向量是清算流量最小的结算方案（总转移量 `Σ|net|` 最小），
  因此可行时净额解即最优解；`balanced` 表示各主体净额之和为零。

## 错误码与退出码

| 代码 | 退出码 | 含义 |
| --- | --- | --- |
| `E_PARSE` | 2 | JSON 语法错误、字段缺失/非法、`den=0`、非正汇率等 |
| `E_PENDING` | 3 | 某币种没有通向本位币的汇率路径（未决限界）——**不会**被当作不可满足 |
| `E_REF` | 4 | `undo`/`correct` 引用未知或已失效的事件、重复发票 id、未知本位币 |
| — | 1 | `verify` 复核失败 |
| — | 0 | 正常（含 `infeasible` 带证书，这是有效计算结果而非错误） |

## 验收与真实运行结果

以下输出为 `bash examples/run.sh`（= `npm run example`）的真实运行记录。

### 1. 正常三主体两币种，净额为零

`examples/normal.jsonl`：A、B 各应收 350 CNY，C 应付 100 USD，汇率 USD/CNY=7。

```
$ node src/cli.js settle examples/normal.jsonl --base CNY
{
  "status": "ok",
  "base": "CNY",
  "balanced": true,
  "totalExact": "0",
  "nets": [
    { "party": "A", "exact": "350",  "rounded": "350.00",  "roundingError": "0", "errorBound": "1/200" },
    { "party": "B", "exact": "350",  "rounded": "350.00",  "roundingError": "0", "errorBound": "1/200" },
    { "party": "C", "exact": "-700", "rounded": "-700.00", "roundingError": "0", "errorBound": "1/200" }
  ],
  "historyHash": "d76f54dfda063fb598deaf5b1ff9e38b30fa639eafda0a2f155f776fca2f3153",
  "stats": { "appended": 4, "undone": 0, "corrected": 0, "hashRecomputations": 0 }
}
```

### 2. 汇率矛盾：证书可被 verify 独立复核

`examples/conflict.jsonl`：USD/CNY=7、CNY/EUR=1/7、EUR/USD=1/2（环积 1/2 ≠ 1）。

```
$ node src/cli.js settle examples/conflict.jsonl --base CNY --cert-out cert.json
{
  "status": "infeasible",
  "reason": "rate-conflict",
  "certificate": {
    "type": "rate-conflict",
    "minimality": "exact-minimum",
    "events": ["evt:1", "evt:2", "evt:3"],
    "detail": {
      "description": "existing edges imply value(EUR)/value(USD) = 1, but evt:3 asserts 1/2",
      "impliedRatio": "1", "assertedRatio": "1/2", "cycleProduct": "1/2", "expected": "1"
    }
  }
}
settle exit=0
$ node src/cli.js verify examples/conflict.jsonl cert.json
{ "valid": true,
  "checks": { "eventsResolved": true, "payloadsMatch": true, "inconsistent": true, "minimal": true } }
verify exit=0
```

### 3. 随机 N≤8 与暴力枚举对照

`test/rates.test.js` 以固定种子生成 300 组 N≤8 的随机汇率事件，
引擎证书大小与暴力枚举的最小不可行子集逐一相等，且证书本身不可行、
去掉任意一条即可行；`test/settle.test.js` 以 200 组随机发票与独立的
朴素 BFS 净额实现对照，精确值逐方一致，舍入误差均不超过声明误差界。

### 4. 撤销后恢复历史哈希

`examples/undo.jsonl`：第 3 行加发票、第 4 行撤销它、第 5 行更正、第 6 行撤销更正。
`hash` 输出的逐事件哈希显示 `evt:2 == evt:4 == evt:6`（撤销后哈希精确恢复）：

```
evt:2 d144932081f8b097287e6635796d1f78564bf4a9e879ee3edb8b232317a58def
evt:3 701d4719764d9cf5ffc7dd117be7c6309909580f440fee68eefffa13d628ce06
evt:4 d144932081f8b097287e6635796d1f78564bf4a9e879ee3edb8b232317a58def
evt:5 dc637f2311b38ae4707e94a4f58ca54216fd725fc04600ba85855e97400ce497
evt:6 d144932081f8b097287e6635796d1f78564bf4a9e879ee3edb8b232317a58def
```

增量性由 `test/eventlog.test.js` 验证：2500 事件后执行 correct/undo，
`hashRecomputations` 恒为 0，且头部哈希与从头复核的 `referenceHash` 一致。

### 5. 未决与错误码（真实输出）

```
$ node src/cli.js settle examples/pending.jsonl --base CNY
{ "status": "pending",
  "error": { "code": "E_PENDING",
             "message": "no rate path to base \"CNY\" for: JPY",
             "pendingCurrencies": ["JPY"] } }
exit=3                       # 未决，绝不当作不可满足

$ node src/cli.js settle bad.jsonl      # den=0
{"error":{"code":"E_PARSE","message":"line 1: division by zero","line":1}}
exit=2
$ node src/cli.js settle ref.jsonl      # undo evt:9 不存在
{"error":{"code":"E_REF","message":"undo: unknown eventId \"evt:9\""}}
exit=4
```

### 6. 测试

```
$ node --test
# tests 5
# pass 5
# fail 0
```

## 目录结构

```
src/rational.js   精确有理数（BigInt）、银行家舍入与误差界
src/eventlog.js   JSONL 解析、undo/correct、增量历史哈希（LtHash 风格）
src/rates.js      带权并查集一致性判定、最小冲突子集证书
src/settle.js     净额结算、末位舍入、E_PENDING 判定
src/verify.js     证书独立复核
src/cli.js        settle / verify / hash 命令（runCli 可编程调用）
test/             node:test 验收与随机对照测试
examples/         示例数据与 run.sh（= npm run example）
```
