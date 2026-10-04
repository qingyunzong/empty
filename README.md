# ledger-audit

本地结算批次审计库与 CLI。Node.js 22，仅标准库，无网络依赖。

## 用法

```sh
node cli.js audit rules.json ledger.jsonl   # 审计账本，输出 match / minimized
node cli.js equiv rulesA.json rulesB.json   # 规则集等价判定，输出 equiv / witness
node cli.js minimize rules.json             # 最小化 DFA + 可核验划分证书
node cli.js apply rules.json [--state FILE] # 应用规则版本（自动快照前一版本）
node cli.js snapshot [--state FILE]         # 记录显式快照
node cli.js undo [--state FILE]             # 回退到最近显式快照
node cli.js status [--state FILE]           # 查看当前版本哈希
```

## 输入格式

- `rules.json`：`{"rules":[{"id","pattern","action"}]}`，也接受字符串数组。
- `ledger.jsonl`：每行一个 JSON 对象，字段 `batch, account, currency, amount,
  direction, timestamp`。规则匹配的拼接串为
  `batch|account|currency|amount|direction|timestamp`（全串匹配）。

## 正则方言

字面量、字符类 `[a-z]`/`[^...]`、连接、并 `|`、星号 `*`、括号、`?`；`[^]` 表示任意
字符。反向引用与未列出的构造一律报 `BAD_REGEX`。规则 ≤ 80 字符，账本 ≤ 50000 行。

## 错误码

`BAD_REGEX`（非法规则）、`BAD_LINE`（非法/越界账本行）、`NO_SNAPSHOT`（无显式快照
可回退）、`AMBIGUOUS_RULE`（一行命中动作冲突的多条规则）。出错时不写任何状态。

## 测试

```sh
node --test
```

真实运行结果见 `RESULTS.md`。
