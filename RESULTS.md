# RESULTS

日期：2026-10-04 ｜ 环境：Node.js v22.22.1，仅标准库，单机离线，未使用任何网络/外部服务。

## 测试运行（真实输出）

命令：`node --test`

```
ok 1 - test/audit.test.js
ok 2 - test/automata.test.js
ok 3 - test/enumeration.test.js
ok 4 - test/equiv.test.js
ok 5 - test/errors.test.js
ok 6 - test/helpers.js
ok 7 - test/regex.test.js
ok 8 - test/state.test.js
1..8
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5248.035408
```

## 验收对照

- **A 合法规则命中且金额汇总正确**：`test/audit.test.js`。5 行账本、规则 `[^]*\|USD\|[^]*`
  命中第 1/3/4 行，`totalAmount = 100.5 - 25.25 + 10 = 85.25`（credit 为正、debit 为负），
  `minimized.certificateValid === true`。通过。
- **B 非法正则与越界行报码且不写状态**：`test/errors.test.js`。`a(b`、`x\1y`、81 字符规则、
  `a+b`、`\d` → `BAD_REGEX`；金额 1e13 越界、非法 direction/currency/timestamp、非法 JSON
  → `BAD_LINE`（含行号）；无快照 undo → `NO_SNAPSHOT`；动作冲突 → `AMBIGUOUS_RULE`。
  断言出错后状态文件不存在/内容不变。通过。
- **C 独立枚举对照**：`test/enumeration.test.js`。字母表 `{a,b,0,1}`、长度 ≤ 8 共
  87381 个串：6 个模式的 DFA 成员判定与独立的递归 AST 匹配器逐一比对一致；
  12 组规则集等价性与枚举出的对称差逐一比对，非等价时见证串等于枚举中
  “长度最短、同长度码点数值最小”的串（含空串见证用例）。通过。
- **D 连续 apply 后 undo 恢复前一哈希**：`test/state.test.js`。apply v1→v2→v3 后两次
  undo 依次恢复 v2、v1 的 sha256 哈希，再次 undo 报 `NO_SNAPSHOT`；
  显式 `snapshot` 后方可 undo；坏规则 apply 抛 `BAD_REGEX` 且状态文件不变。通过。

## CLI 真实输出

`node cli.js audit examples/rules.json examples/ledger.jsonl`（节选，exit 0）：

```json
{"lines":5,"match":{"count":3,"totalAmount":85.25,"lineNumbers":[1,3,4]},
 "minimized":{"states":18,"transitions":378,"certificateValid":true,"certificate":{...}}}
```

`node cli.js equiv ra.json rb.json`（`a|bb` vs `a|bbb`）：

```json
{ "equiv": false, "witness": "bb" }
```

`node cli.js equiv rc.json rd.json`（`(a|b)*` vs `(b|a)*`）：

```json
{ "equiv": true, "witness": null }
```

连续 `apply` / `undo`（`--state st.json`）：

```
apply v1 -> hash 568881dc…4a37, snapshots 0
apply v2 -> hash fecd0525…e46b, snapshots 1
undo     -> hash 568881dc…4a37  （恢复前一哈希）
undo     -> {"error":{"code":"NO_SNAPSHOT",...}}  exit=1
```

错误路径（均 exit 1，JSON 写 stderr，不写状态文件）：

```
audit bad.json      -> {"error":{"code":"BAD_REGEX","message":"unbalanced '('"}}
audit backref.json  -> {"error":{"code":"BAD_REGEX","message":"backreference \\1 is not allowed"}}
audit badline.jsonl -> {"error":{"code":"BAD_LINE","message":"line 1: amount out of range (|amount| > 1000000000000)"}}
audit amb.json      -> {"error":{"code":"AMBIGUOUS_RULE","message":"line 1 matches rules [r1, r2] with conflicting actions [flag, pass]"}}
```

## 设计要点

- **字段拼接串**：`batch|account|currency|amount|direction|timestamp`（amount 为
  `String(amount)`），规则对整串做**全串匹配**；`[^]` 表示任意字符（空字符类取反）。
- **正则方言**：字面量、字符类（含范围与 `^` 取反）、连接、并 `|`、星号 `*`、括号、
  `?`；`\` 可转义非字母数字字符。反向引用 `\1..\9`、未支持构造（`.` `+` `{}` `^` `$`
  `\d` 等）、括号/字符类不闭合、规则 > 80 字符 → `BAD_REGEX`。
- **自动机管线**：Thompson NFA（区间标记）→ 子集构造 DFA（全码点区间字母表
  [0, 0x10FFFF]）→ 划分细化最小化。划分证书含 blocks、块间转移、接受块与**每对块的
  分隔串**；`verifyCertificate` 校验：块是精确划分、块内一致（互模拟 ⇒ 等价）、
  块间均可区分（分隔串 ⇒ 不等价），合起来即 Myhill-Nerode 划分，最小化可核验。
- **等价与见证**：两规则集各取并语言，共享字母表构造 DFA 后在积自动机上 BFS，
  按码点升序扩展 ⇒ 见证为长度最短、同长度数值最小。
- **版本管理**：`apply` 先完整校验规则（失败不写状态），把前一版本作为显式快照入栈；
  `undo` 仅回退到显式快照，栈空报 `NO_SNAPSHOT`；一行命中多条动作冲突的规则报
  `AMBIGUOUS_RULE`，绝不当作不匹配。
- **规模限制**：账本 ≤ 50000 行，规则 ≤ 80 字符，|amount| ≤ 1e12。
