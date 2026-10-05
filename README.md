# 卡交易风控规则工具

Node.js 22，仅标准库。交易 token 化为五元组串，规则为正则（命中即拒绝），
支持规则证书、规则集等价判定（含最短分歧见证）、dry-run / apply / undo 与崩溃恢复。

## Token 化

每笔交易映射为一个 5 字符 token（字母表共 192 个，按五元组字典序排列）：

| 位置 | 含义 | 取值 |
| --- | --- | --- |
| 1 | 金额档 | `L`<100, `M`<1000, `H`<10000, `X`≥10000 |
| 2 | 时段 | `N`夜 0-5, `M`早 6-11, `A`午 12-17, `E`晚 18-23 |
| 3 | 地区 | `D`domestic, `F`foreign |
| 4 | 渠道 | `P`pos, `E`ecom, `A`atm |
| 5 | 历史标记 | `0`正常, `1`有标记 |

域外取值（未知地区/渠道/金额/小时/标记）报 `TOKEN_UNKNOWN`。

## 规则语法（≤60 字符）

token 原子 = 5 个位置说明符：字面量、`.`（任意）、`[HX]`（类）、`[^H]`（反类）。
算子：连接、`|`、`*`、`+`、`?`、`(...)`。规则文件每行一条规则，支持
`name = <regex>` 命名规则与 `@name` 引用；引用成环报 `RULE_CYCLE_UNSUPPORTED`。
规则集语言 = 各规则的并。

```
XNF..            # 极高金额 + 夜间 + 境外
(HNF..)(HNF..)   # 连续两笔高金额境外夜间
...A1            # ATM 渠道且有历史标记
```

## 核心机制

1. **证书**：规则 → Thompson NFA → 子集构造确定化 → 划分求精最小化 →
   按字母序 BFS 规范化，输出状态数与转移的 SHA-256 哈希。
   语言等价 ⇔ 证书一致。
2. **等价判定**：比较两个最小 DFA 的规范形；不等价时在积 DFA 上按 token
   字典序 BFS，返回最短、同长字典序最小的分歧 token 串（witness）。
3. **运行语义**：流式评估，某笔交易的 token 使规则匹配完成（Σ*·L）即拒绝。
   dry-run 只评估；apply 经 决定→检查点→提交 三阶段写本地状态；
   undo 逆推最近一次 apply 的额度增量。被拒绝/失败的交易不产生任何额度冻结。

## CLI

```sh
node cli.js equiv a.re b.re                     # {equiv, certA, certB, witness}
node cli.js run rules.re tx.jsonl               # dry-run（默认）
node cli.js run rules.re tx.jsonl --mode apply --state st/state.json
node cli.js run rules.re tx.jsonl --mode apply --state st/state.json --fail-at after-checkpoint
node cli.js recover --state st/state.json
node cli.js undo --state st/state.json
```

故障注入点（`--fail-at` 或环境变量 `RC_FAIL_AT`）：
`before-decision`（写决定前）、`after-decision`（决定已写未写检查点）、
`after-checkpoint`（检查点已写未提交）。崩溃后再次 apply 报 `APPLY_CONFLICT`，
`recover` 幂等恢复（已提交的 runId 绝不重复扣减额度）。

## 错误码

`TOKEN_UNKNOWN` · `RULE_CYCLE_UNSUPPORTED` · `APPLY_CONFLICT` · `UNDO_EMPTY`

## 测试

```sh
node --test
```
