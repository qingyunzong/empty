# escrow-fold

券商托管平台的成交回报更正与冻结台账引擎。接收可更正、可撤销的成交回报，
任意时刻回答"按当前有效回报应冻结多少"。纯 Node.js 22 标准库实现，无依赖。

## 架构

```
DSL 文本 ──lex──> token ──parse(Pratt)──> AST ──check(静态类型)──> 字节码 ──VM──> 有效版本图 + 冻结台账
```

- `src/lexer.js` — 词法器：成交号、版本号（`v2`）、ISIN、买/卖、数量、价格、日期
- `src/parser.js` — 行语法 + Pratt 表达式解析（净价/全价 `@ <expr> net|gross`，费用 `fee <expr>`）
- `src/check.js` — 静态类型校验：买卖方向 × 资产类型（股票 `CNE*` 必须 gross，债券 `CND*` 必须 net+应计利息）
- `src/compile.js` — 编译为字节码（表达式 → 栈机指令；事件 → 单条 VM 指令）
- `src/vm.js` — VM：有效版本图、增量 delta、冻结台账、seq 幂等、只追加的审计 journal
- `src/cli.js` / `bin/escrow.js` — CLI
- `reference/fold.js` — 独立参考折叠器（全量重算 + 树遍历求值），供差分测试对照

## DSL

```
deposit 2026-10-03 CNE000000001 qty 100000 cash 10000000
trade A v1 2026-10-03 buy 1000 CNE000000001 @ 10 gross fee 30
trade B v1 2026-10-03 sell 200 CNE000000001 @ 10.5 gross fee qty * price * 0.0003
trade C v1 2026-10-03 buy 100 CND000000001 @ 99.5 + 0.25 net accrued 0.25 fee 5
amend A v2 2026-10-03 buy 1500 CNE000000001 @ 10.5 gross fee 40
cancel A v2 2026-10-03
```

- 表达式支持 `+ - * / %`、括号、一元负号；费用表达式可用变量 `qty` / `price` / `accrued`
- 金额/价格为 1e-6 定点（BigInt），数量是整数
- 作用域按交易日隔离：`amend`/`cancel` 只能引用同一交易日内的本成交（跨日引用报 `E_VERSION`）
- `cancel` 只追加 tombstone；目标版本尚未到达时是"未决更正"，不是错误，版本到达时即失效

## 语义

- 新版本不改写历史：VM 计算新旧有效版本之差，生成增量 delta 提交台账，并写入审计 journal
- 有效版本 = 未被 tombstone 的最高版本号；同号并发版本按内容哈希（SHA-256）tie-break
- 最终冻结 = 所有有效版本折叠；任何台账单元必须满足 `0 <= frozen <= held`，
  违反则整个事件以 `E_NEG` 拒绝，状态不变（不消耗 seq）
- 同一 `seq` 重放相同内容 = 幂等 no-op；相同 `seq` 不同内容或 seq 倒退 = `E_SEQ`

## 错误码

| 代码 | 含义 |
| --- | --- |
| `E_VERSION` | 版本图/作用域违规（重复成交号、引用未知成交、跨日更正、版本号非法） |
| `E_SIGN` | 静态类型错误（方向/资产类型不匹配、负数量或负价格、净价/全价与资产类型不符） |
| `E_NEG` | 冻结越界（卖空超过持仓、冻结现金超过可用、冻结为负），事件整体拒绝 |
| `E_SEQ` | 序号违规（同号不同内容、序号倒退） |
| `E_PARSE` | 词法/语法错误 |

## CLI

```console
$ node bin/escrow.js fold examples/ticks.jsonl --at 6 --pretty
{
  "lastSeq": 6,
  "ledger": {
    "2026-10-03|CNE000000001": {
      "heldQty": "100000", "frozenQty": "200",
      "heldCash": "10000000", "frozenCash": "15790"
    }, ...
  },
  "scopes": { "2026-10-03": { "A": { "effective": { "version": 2, ... } } } }
}
```

- `escrow fold ticks.jsonl` — 折叠整个文件，输出最终台账与有效版本图（JSON）
- `--at seqN` — 只输出 `seq <= N` 的前缀状态（任意历史时点审计）
- 输入为 JSONL：每行 `{"seq":N,"text":"<DSL>"}`
- 出错时 stderr 输出 `{"error":"E_NEG","message":"...","seq":N}`，退出码 1

## 测试

```console
$ node --test
```

覆盖四条验收：更正链 A1→A2→撤销 A2 回到 A1；越界卖空 `E_NEG` 且状态不变；
同一 seq 重放幂等；随机 200 事件与独立折叠参考逐前缀对照（另含 5 种子扫描）。
