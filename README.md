# PLC 报警日志离线审计工具

单机离线、仅 Node.js 22 标准库、零依赖。回答安全员的核心问题：

> 某正则危险模式是否可能出现在满足过滤条件的日志投影中？

- 若**可能**：输出最短见证 `SAT{"witness":...,"len":...}`（DFA 上 BFS 求得）。
- 若**不可能**：输出可复核空集证书 `UNSAT{"certHash":...,"states":...}`——
  证书为**最小化 DFA**（接受态数为零）的规范序列化之 SHA-256。

## 正则语法

| 构造 | 语法 | 说明 |
|---|---|---|
| 字面量 | `a` | 单字符；元字符用 `\` 转义 |
| 连接 | `ab` | 隐式 |
| 并 | `a\|b` | |
| 交 | `p&q` | 自动机乘积 |
| 补 | `~p` | **仅在显式有限字母表上**，否则报错退出码 5 |
| 星号/加号 | `p*` `p+` | |
| 空串/空语言 | `EPS` / `NIL` | |
| 分组 | `(...)` | |

优先级：`~`/`*`/`+` > 连接 > `&` > `|`。

实现路径：Thompson 构造 NFA → 子集构造确定化（全函数，含汇态）→
交（积构造）/补（翻转接受态）→ 划分精化最小化（状态按 BFS 规范序编号，
保证同一语言得到同一证书哈希）。测试中用独立的 Brzozowski 导数匹配器交叉验证。

## 规则包（append-only + CRC + 坏尾截断）

规则包是 append-only 文件，每行一条记录：

```
{"crc":"<body 的 CRC-32(IEEE)>","body":{"type":"pack","version":n,"rules":[...]}}
```

- 每条记录先过 CRC 校验；**完整记录 CRC 失败** → `ERROR CRC_FAILED`，退出码 5。
- 文件**末尾的半条记录**（崩溃截断、无换行终止）→ 物理截断坏尾，
  恢复到上一完整版本，`PACK{...,"truncated":true}`。
- `rollback` 到不存在版本 → `ERROR UNKNOWN_VERSION`，退出码 5，现态与文件均不变。

规则：`{"id":"...","pattern":"...","filter":"...","alphabet":["a","b"]}`。
`check` 计算 `L(会话过滤) ∩ L(规则过滤) ∩ L(危险模式)` 的判空。

## 命令流（JSONL）

`node cli.js audit.jsonl`，每行一条命令：

```json
{"op":"loadPack","path":"rules.pack"}
{"op":"appendPack","path":"rules.pack","rules":[{"id":"r1","pattern":"a(b|c)*","alphabet":["a","b","c"]}]}
{"op":"setFilter","regex":"b(a|b)*","alphabet":["a","b"]}
{"op":"setFilter"}
{"op":"check"}
{"op":"check","pattern":"~(a*)&(a|b)*","alphabet":["a","b"]}
{"op":"rollback","version":1}
```

输出（stdout，每行一条）：`PACK{...}` / `APPENDED{...}` / `FILTER...` /
`<ruleId> SAT{"witness":"baa","len":3}` / `<ruleId> UNSAT{"certHash":"...","states":1}` /
`ROLLBACK{"version":1}`。

错误（stderr + 退出码）：

| 退出码 | 含义 |
|---|---|
| 5 | 补集无显式字母表（`COMPLEMENT_NO_ALPHABET`）、CRC 失败（`CRC_FAILED`）、未知 pack（`UNKNOWN_PACK`）、未知版本（`UNKNOWN_VERSION`） |
| 4 | 命令行不是合法 JSON / 未知 op |
| 2 | CLI 参数或输入文件问题 |

## 真实运行记录

`node cli.js demo/audit.jsonl`（2026-10-08，Node v22.22.1）实际输出：

```
PACK{"path":"demo/rules.pack","versions":1,"current":1,"truncated":false}
danger-double-alarm SAT{"witness":"aa","len":2}
impossible-combo UNSAT{"certHash":"542e6526679bad37279cbc1d28a49a61f8f506b5337feff551f416ad75a2c121","states":1}
FILTER{"regex":"b(a|b)*","alphabet":["a","b"]}
adhoc SAT{"witness":"baa","len":3}
FILTERnull
adhoc SAT{"witness":"b","len":1}
ROLLBACK{"version":1}
```

错误路径实测：

```
$ node cli.js /tmp/err.jsonl    # {"op":"check","pattern":"~(a*)"}
ERROR COMPLEMENT_NO_ALPHABET complement (~) used but no explicit alphabet was provided   (exit 5)
$ node cli.js /tmp/err2.jsonl   # {"op":"loadPack","path":"demo/missing.pack"}
ERROR UNKNOWN_PACK pack file not found: demo/missing.pack                                 (exit 5)
```

## 测试

`node --test`（或 `npm test`）。实测结果（2026-10-08，Node v22.22.1）：
4 个测试文件、共 17 个测试全部通过，0 失败。

| 文件 | 覆盖验收项 |
|---|---|
| `test/automata.test.js` | ① 交/补组合（11 个固定用例 + 60 个种子随机用例）与 ≤7 全枚举（255 词，导数匹配器独立参照）一致 |
| `test/equiv.test.js` | ② 同语义不同正则：SAT 最短长相同；UNSAT 证书哈希逐字节相同 |
| `test/pack.test.js` | ③ 截断最后半条记录后重启回到上一完整 pack（坏尾被物理截断、幂等）；④ rollback 不存在版本报错且现态与文件不变；另有 CRC 失败、未知 pack |
| `test/cli.test.js` | CLI 端到端：SAT/UNSAT 输出形状、会话过滤、三类退出码 5 错误 |

## 文件结构

```
cli.js            CLI 入口（薄封装）
lib/regex.js      正则解析器（AST）
lib/nfa+dfa       见 lib/dfa.js：确定化/交/补/最小化/最短见证/证书哈希
lib/compile.js    AST→NFA→DFA 编译 + 导数参照匹配器
lib/pack.js       CRC-32、append-only 记录层、坏尾截断、版本加载
lib/engine.js     命令执行引擎（loadPack/appendPack/setFilter/check/rollback）
lib/runner.js     命令流驱动（cli.js 与测试共用）
demo/             演示规则包与命令流
test/             node:test 验收测试
```
