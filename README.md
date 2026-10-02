# factory-schedule-judge

离线单机运行的离散工厂排产判定器。设备事件看作字母（如 `S`,`A`,`B`,`F`)，
规则是两类正则禁则：**红则**禁止出现，**黄则**出现需后续确认。库把多条正则
确定性地编译成可增量更新的 DFA 判定器，对计划事件序列给出
`feasible` / `needs-confirmation` / `rejected` 判定，并支持规则库的分层
撤销/重做，撤销后恢复到一致快照。

仅使用 Node.js 22 标准库与 `node:test`，无第三方依赖。

## 运行

```sh
npm test                              # 等价于 node --test
node cli.js rules.jsonl plan.txt      # 判定一份计划
node cli.js examples/rules.jsonl examples/plan.txt
```

## 架构

- `src/regex.js` — 正则解析器，产出 AST；语法错误携带模式内偏移。
- `src/automata.js` — Thompson NFA 构造、子集确定化、划分精化最小化；
  最小 DFA 按 BFS 规范重编号，等价的自动机结构逐字节相同。
- `src/matcher.js` — 独立的回溯匹配器，只用于测试对照，与 DFA 管线零共享代码。
- `src/rulelib.js` — 规则库：分层 undo/redo、层事务化提交、快照哈希、
  计划评估、两库最短区分见证。
- `src/engine.js` — rules.jsonl 日志解释器，把错误包装成带行/列位置的 `CliError`。
- `cli.js` — 命令行入口；`runCli(args, io)` 可注入 IO，便于进程内测试。

## 正则语法

```
alt    := concat ('|' concat)*
concat := repeat*
repeat := atom ('*' | '+' | '?')*
atom   := '(' alt ')' | '[' class ']' | '\' char | '.' | 字面字符
```

- 空串、`()`、`a|` 中的空分支都是 ε。
- 字符类支持 `[abc]`、`[a-z]`、`[^a]`；`\` 转义任意字符。
- `.` 与否定类在当前**字母表**上取值；字母表 = 规则库中全部字面字符的并集。
  空字母表合法（此时只有 ε 一个串）。
- 判定语义是**出现**：计划串的任意子串匹配规则即命中（等价于 `Σ*·R·Σ*`)。

## rules.jsonl 格式

每行一个 JSON 对象，空行忽略：

```json
{"op":"add","id":"r1","kind":"red","pattern":"FF"}
{"op":"add","rules":[{"id":"y1","kind":"yellow","pattern":"SA"},{"id":"r2","kind":"red","pattern":"BA"}]}
{"op":"del","id":"r1"}
{"op":"del","ids":["r2","y1"]}
{"op":"undo","k":2}
{"op":"redo"}
```

- 每个 add/del 行是一个**修订层**；`undo`/`redo` 以层为单位回退/重放（`k` 默认 1)。
- 层是事务：层内任一操作失败（语法错、重复 id、未知 id)，整层不提交，
  旧层与历史栈不受污染。
- 新的 add/del 会清空 redo 栈。

## plan.txt 格式

忽略所有空白字符，其余每个字符是一个事件；空计划合法。

## 输出

stdout 输出 JSON，退出码 0:

```json
{
  "status": "rejected",
  "matchedRuleIds": ["r2", "y2"],
  "snapshotHash": "e86431aa…",
  "witness": "SA"
}
```

- `status`:`feasible`（无命中）/ `needs-confirmation`（仅黄则命中）/
  `rejected`（红则命中，红优先于黄）。
- `matchedRuleIds`：全部命中规则 id（红、黄合并，字典序）。
- `witness`：拒绝时为**最短反例**——计划中最短的匹配红则子串（BFS 求得）;
  否则为 `null`。
- `snapshotHash`：对红/黄两个并集最小 DFA 的规范形做 SHA-256。
  与规则 id、插入顺序无关；等价改写规则集后哈希不变。

## 错误

下列错误均以退出码 2 终止，stderr 给出位置（`文件:行[:列]`)：

```
rules.jsonl:2:4: regex syntax error: expected ')'
rules.jsonl:2: unknown rule id 'ghost'
rules.jsonl:2: undo out of bounds: requested 5, only 1 revision(s) available
```

文件不可读退出码 1；参数缺失打印用法并退出码 2。

## 库 API

```js
const { RuleLibrary, distinguishingWitnessForLibs } = require('./src/rulelib');
const { runRulesLog } = require('./src/engine');

const lib = runRulesLog(logText);        // 或 new RuleLibrary() + applyLayer/undo/redo
lib.evaluate('SABF');                    // { status, matchedRuleIds, witness, snapshotHash }
lib.snapshotHash();                      // 64 位十六进制
distinguishingWitnessForLibs(a, b);      // 等价 -> null；否则最短区分串
```

等价判定在两库的并字母表上进行：对红、黄两层的"出现语言"并集 DFA 做乘积
BFS，返回最短区分见证；两层都无区分串则判等价。

## 验收标准对应

1. 等价改写 → 见证为空且哈希不变：`test/equivalence.test.js`。
2. 红优先于黄、最短反例：`test/evaluate.test.js`。
3. 交错 add/del/undo/redo 与重放有效日志一致：`test/undoredo.test.js`。
4. 长度 ≤ 8 全枚举对照独立回溯匹配器：`test/exhaustive.test.js`
   (7 个模式 × 511 个串 × 出现/全匹配两种语义）。

## 真实测试输出

`npm test`(Node v22.22.1）最近一次运行：

```
> factory-schedule-judge@1.0.0 test
> node --test

TAP version 13
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
# Subtest: test/equivalence.test.js
ok 2 - test/equivalence.test.js
# Subtest: test/evaluate.test.js
ok 3 - test/evaluate.test.js
# Subtest: test/exhaustive.test.js
ok 4 - test/exhaustive.test.js
# Subtest: test/regex.test.js
ok 5 - test/regex.test.js
# Subtest: test/undoredo.test.js
ok 6 - test/undoredo.test.js
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2400.73484
```
