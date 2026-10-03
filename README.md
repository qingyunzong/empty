# escrow-fold

券商托管冻结台账：接收可更正、可撤销的成交回报，任意时刻回答
“按当前有效回报应冻结多少券与现金”。纯 Node.js 22 标准库实现，无第三方依赖。

## 架构

```
JSONL 事件 → lexer → Pratt parser → 静态类型检查 → 字节码 → VM（版本图 + 冻结台账）
```

- `src/lexer.js` — 词法：成交号、版本号 `vN`、ISIN、`buy/sell`、数量、价格、`@`、`net/gross/fee`
- `src/parser.js` — Pratt 解析器：净价/全价与费用表达式（`+ - * /`、括号、一元负号）
- `src/checker.js` — 静态类型校验：数量/价格/费用符号（E_SIGN）；资产类型与报价方式匹配
  （`XS*` 债券必须 `gross`，其余股票必须 `net`）
- `src/compiler.js` — 编译为栈式字节码：`PUSH/ADD/SUB/MUL/DIV/NEG/NEW_TRADE/AMEND/REVOKE`
- `src/vm.js` — VM：有效版本图 + 冻结台账，逐事件应用增量 delta
- `src/fold.js` — 事件流驱动，支持 `--at` 前缀快照

## DSL

```
trade  A v1 on 2024-01-15 buy 100 US0378331005 @ 150.25 net fee 1.5
amend  A v2 on 2024-01-15 buy 120 US0378331005 @ 150.25 + 0.5 net fee 1.5
revoke A v2 on 2024-01-15
```

- 价格/费用是表达式：`@ 2 * 210 net`、`fee 0.1 * 3`、`@ (99 + 0.5) gross`
- `net`：买入冻结现金 = 数量×价格 + 费用；卖出回款 = 数量×价格 − 费用
- `gross`：费用已含在价格内，冻结/回款 = 数量×价格

## 语义

- **作用域按交易日隔离**：`amend`/`revoke` 只能引用同一天的原始成交（`on` 日期必须等于
  该成交的根日期），跨日引用报 `E_VERSION`；更正必须走显式 `amend` 链
  （对已存在成交号再用 `trade` 报 `E_VERSION`）。
- **增量 delta**：新版本不改写历史，版本图保留全部版本；仅把“旧有效版本 → 新有效版本”
  的差额应用到台账。
- **撤销即 tombstone**：`revoke` 只追加墓碑，有效版本回退到最高的未撤销版本。
- **未决更正不等于失败**：版本号落后于当前头、或哈希 tie-break 落败的更正被保留在
  版本图中但不生效，不算错误。
- **最终冻结 = 所有有效版本折叠**：同一成交取最高未撤销版本；同号并发版本按内容哈希
  字典序 tie-break。台账不变量：`netShares = bought − sold ≥ 0`，冻结不为负。
- **幂等重放**：与上一事件 seq 相同且内容哈希相同 → 跳过；否则乱序/跳号报 `E_SEQ`。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `E_VERSION` | 引用未知成交、重复 `trade`、跨日更正/撤销、非法版本号 |
| `E_SIGN` | 数量/价格/费用符号错误；资产类型与报价方式不匹配 |
| `E_NEG` | 折叠后净持仓或冻结为负（如越界卖空）；事件被拒绝，状态不变 |
| `E_SEQ` | seq 跳号、乱序，或同 seq 但内容不同的“重放” |

## CLI

```console
$ node bin/escrow.js fold examples/ticks.jsonl --at 3
{
  "seq": 3,
  "ledger": {
    "2024-01-15|US0378331005": {
      "bought": 100, "sold": 30, "frozenShares": 30,
      "frozenCash": 15026.5, "proceeds": 4544.25, "netShares": 70
    },
    ...
  },
  "trades": { "A": { "effective": { "version": 1, ... }, "tombstoned": [] }, ... }
}
```

- `escrow fold ticks.jsonl` — 折叠全部事件，输出最终台账与版本图
- `--at seqN` — 输出 seq ≤ N 的前缀状态（任意历史时刻的“应冻结多少”）
- 输入为 JSONL，每行 `{"seq": <int>, "text": "<DSL 语句>"}`
- 出错时打印 `error E_XXX at seq N: ...` 并以退出码 1 终止

## 测试

```console
$ npm test    # node --test test/*.test.js
```

覆盖四条验收：更正链回退、越界卖空 E_NEG 且状态不变、同 seq 重放幂等、
随机 200 事件与独立折叠参考逐前缀对照（多个种子）。详见 `RESULTS.md`。
