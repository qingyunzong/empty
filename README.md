# plc-audit — PLC 报警日志离线审计工具

单机离线运行的 Node.js 22 库与 CLI（仅标准库 + `node:test`，零依赖）。
回答安全员的核心问题：**某正则危险模式是否可能出现在满足过滤条件的日志投影中**。

- 若**可能**：给出**最短见证** `SAT{witness, len}`（DFA 上 BFS，保证最短）。
- 若**不可能**：给出可复核**空集证书** `UNSAT{certHash, states, acceptCount}`——
  即投影过滤与危险模式求交后的**最小化 DFA**（`states` 为状态数，
  `acceptCount` 为接受状态数，恒为 0），`certHash` 是最小化 DFA 经
  BFS 规范化编号后的 SHA-256 截断哈希，语义相同的正则得到相同证书。
- 规则包持久化到 **append-only** 文件，每条记录带 **CRC-32** 校验；
  故障恢复时逐条校验，**坏尾截断**（如半截记录）回到上一完整状态，
  中段损坏则报错退出。

## 运行

```sh
node --test                      # 运行全部测试
node cli.js audit.jsonl          # 处理审计命令，结果写 stdout，错误写 stderr
AUDIT_STORE=packs.log node cli.js examples/audit.jsonl
```

`AUDIT_STORE` 指定规则包存储文件（默认 `./packs.log`）。退出码：0 正常；
**5** 表示补集无字母表（`COMPLEMENT_NO_ALPHABET`）、CRC 校验失败
（`CRC_FAILED`）、未知包/版本（`UNKNOWN_PACK` / `UNKNOWN_VERSION`）等审计错误。

## 正则语法

| 构造 | 语法 | 说明 |
|---|---|---|
| 连接 | `ab` | 隐式连接，优先级高于 `&` 和 `|` |
| 并 | `a\|b` | |
| 交 | `r1 & r2` | |
| 星号 | `r*`、`r+` | `r+` 等价于 `rr*` |
| 补 | `~r` | 仅在包声明的**显式有限字母表**上定义 |
| 分组 | `(r)` | |
| 空串 / 空语言 | `1` / `0` | `~0` 即 Σ* |
| 转义 | `\` + 任意字符 | 字面空格需写 `\ `（未转义空白被忽略） |

危险模式与过滤器均为上述正则；`setFilter` 可选 `project: [字符]` 表示
日志投影：保留集合外的符号先从危险模式语言中擦除，再与过滤正则求交。

## 命令（JSONL，每行一条）

```json
{"cmd":"loadPack","name":"plc-core","version":1,"alphabet":["a","b","c"],"danger":"(a|b|c)*abb(a|b|c)*"}
{"cmd":"setFilter","regex":"~((a|b|c)*bb(a|b|c)*)","project":["a","b"]}
{"cmd":"check"}
{"cmd":"rollback","name":"plc-core","version":1}
```

- `loadPack`：注册规则包版本（危险模式 + 可选显式字母表），持久化并置为当前。
- `setFilter`：设置会话过滤器（正则 + 可选投影），不持久化。
- `check`：求交判空，输出 `SAT{witness,len}` 或 `UNSAT{certHash,states,acceptCount}`。
- `rollback`：回退到指定版本（持久化）；版本不存在时报错退出码 5，现态不变。

## 实测结果（Node v22.22.1）

`node --test`：**13/13 通过**（`test/acceptance.test.js` 7 项 +
`test/cli.test.js` 6 项），覆盖全部验收标准：

1. 交/补组合与 ≤7 全枚举一致（11 组组合 × 255 个串，独立 oracle 匹配器交叉验证）。
2. 语义相同的不同正则（如 `a(a|b)*` 与 `a(~0)`、双重补）→ 同为 UNSAT
   （证书哈希相同）或最短见证长度相同。
3. 截断最后半条记录后重启，回到上一完整 pack（文件截断至上一完整记录）。
4. rollback 到不存在版本报错（退出码 5），现态不变。

`node cli.js examples/audit.jsonl` 实际输出：

```
{"result":"loaded","name":"plc-core","version":1}
{"result":"filterSet"}
{"result":"UNSAT","certHash":"4f46cf95597a71cd","states":1,"acceptCount":0}
{"result":"loaded","name":"plc-core","version":2}
{"result":"filterSet"}
{"result":"SAT","witness":"aa","len":2}
{"result":"rolledBack","name":"plc-core","version":1}
{"result":"filterSet"}
{"result":"UNSAT","certHash":"4f46cf95597a71cd","states":1,"acceptCount":0}
```

## 结构

- `lib/regex.js` — 正则解析（连接/并/星/交/补）与独立 oracle 匹配器。
- `lib/automata.js` — Thompson NFA、子集构造、乘积交、补集、划分精化最小化、
  BFS 最短见证、规范化证书哈希、投影。
- `lib/packstore.js` — append-only 存储，CRC-32 校验，坏尾截断恢复。
- `lib/audit.js` — 命令引擎（loadPack / setFilter / check / rollback）。
- `cli.js` — CLI 入口（`execute()` 可在进程内复用，便于测试）。
- `test/` — 验收测试；`examples/audit.jsonl` — 示例会话。
