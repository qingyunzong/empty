# 卡交易风控规则工具

Node.js 22、仅标准库。交易 token 化为五元组（金额档/时段/地区/渠道/历史标记），
规则为正则，命中即拒绝。

## Token 化

每笔交易映射为一个 token，如 `a2t3r1c1h1`：

| 维度 | 取值 | 含义 |
| --- | --- | --- |
| 金额档 a | a0/a1/a2/a3 | <100 / <1000 / <10000 / >=10000 |
| 时段 t | t0/t1/t2/t3 | 0-5 / 6-11 / 12-17 / 18-23 时 |
| 地区 r | r0/r1/r2 | domestic / crossborder / sanctioned |
| 渠道 c | c0/c1/c2 | pos / online / atm |
| 历史 h | h0/h1 | clean / flagged |

全字母表 288 个 token，字典序即五元组字典序。

## 规则语法（.re 文件，每行 `name = regex`，单条 <= 60 字符）

- token 模式：`[a3t0r2c*h1]`，五个字段按 a/t/r/c/h 顺序，`*` 为通配（也可写 `c*`）
- 算子：连接、`|`、`(` `)`、`*`、`+`、`?`
- 命名引用：`@name`（循环引用报 `RULE_CYCLE_UNSUPPORTED`）
- 语义：命中 = 交易流中存在以当前交易结尾的子串匹配（即 `.*规则`），命中即拒绝

## CLI

```sh
node cli.js equiv a.re b.re                          # 等价判定 + 证书 + 最短分歧见证
node cli.js run rules.re tx.jsonl                    # 默认 dry-run，只评估
node cli.js run rules.re tx.jsonl --mode apply --state DIR --batch ID [--fault FP1|FP2|FP3]
node cli.js run rules.re tx.jsonl --mode undo --state DIR
node cli.js recover --state DIR                      # 崩溃恢复（幂等，不重复扣减）
```

## 错误码

`TOKEN_UNKNOWN`（维度值无法 token 化）、`RULE_CYCLE_UNSUPPORTED`（规则循环引用）、
`APPLY_CONFLICT`（重复批次或未恢复的 journal）、`UNDO_EMPTY`（空栈 undo）。

## 测试

```sh
node --test
```
