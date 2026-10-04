# lineage-graph

食品工厂批次谱系库 + 查询 DSL + CLI。追踪原料（raw）、半成品（semi）、成品（finished）
批次之间的派生关系，支持事务化录入、undo/redo 撤回错误录入、防有向环、以及带可验证
证书的谱系查询。仅使用 Node.js 22 标准库，单机离线运行。

## 快速开始

```sh
node src/cli.js apply examples/graph.jsonl --out state.json
node src/cli.js query examples/q.dsl --graph state.json > result.json
node src/cli.js verify result.json --graph state.json
node --test          # 运行全部测试
```

## 命令事务（graph.jsonl）

每行一个 JSON 命令：

```json
{"op":"add","id":"LOT-2025-0001","attrs":{"type":"raw","date":"2025-01-01","name":"flour"}}
{"op":"link","from":"LOT-2025-0001","to":"LOT-2025-0002"}
{"op":"unlink","from":"LOT-2025-0001","to":"LOT-2025-0002"}
{"op":"begin"} ... {"op":"commit"}
{"op":"undo"}
{"op":"redo"}
```

- 边方向：`link FROM TO` 表示 `FROM`（上游原料）派生出 `TO`（下游产品），边类型固定为
  `derives_from`（静态模式定义于 `src/schema.js`）。
- `begin`/`commit` 之间的命令构成一个事务：任一命令失败（例如成环）时整个事务回滚，
  不留部分写入。事务外的单行命令各自是独立事务。
- `undo`/`redo` 以已提交事务为粒度撤销/重做（不允许出现在事务块内）。
- 禁止形成有向环（含自环），违反时 `apply` 以 exit 1 拒绝且不写状态文件。
- 每次提交/撤销/重做都会使图版本号 `version` 递增。

## 查询 DSL

```
let upstream = ancestors(LOT-2025-0004);
query upstream where type == "semi" and date >= 2025-01-03 or type == "raw";
query descendants(LOT-2025-0001);
query shortestPath(LOT-2025-0001, LOT-2025-0004);
```

- 词法层识别批号（`LOT-2025-0001`）、日期（`2025-01-15`，校验真实日历日期）、
  字符串（支持 `\"` `\\` `\n` `\t` 转义）、数字与 `#` 行注释。
- `where` 过滤表达式由 Pratt 解析器处理，优先级：`or` < `and` < 比较运算
  （`== != < <= > >=`），`not` 与括号可改变结合。
- `let` 变量在编译期解析到槽位（词法作用域）：引用未定义变量、重复声明均为编译错误。
- 查询编译为字节码（`PUSH/LOAD/STORE/CALL/FILTER/EMIT`）后在虚拟机上执行；
  支持 `ancestors`、`descendants`、`shortestPath` 三个图函数。
- 结果集去重并按批号字典序排序，输出确定。

## 证书与验证

每条 `query` 语句输出一个证书：

```json
{
  "query": "query ancestors(LOT-2025-0004);",
  "commandHash": "…sha256(已应用命令日志)…",
  "graphVersion": 8,
  "resultKind": "set",
  "result": ["LOT-2025-0001", "…"],
  "paths": [["LOT-2025-0001", "…"]],
  "pathHashes": ["…sha256(每条见证路径)…"],
  "program": "…完整 DSL 源码…",
  "statementIndex": 0,
  "hash": "…sha256(以上字段的规范化 JSON)…"
}
```

`program`/`statementIndex` 让证书在引用 `let` 变量时也能自包含重放。`verify` 重算所有
路径哈希与证书哈希；提供 `--graph state.json` 时还会比对命令哈希、图版本，校验见证
路径真实存在于图中，并在图上重新执行完整程序比对对应语句的结果。篡改路径、结果或
版本都会导致验证失败（exit 1）。

## CLI

```
node src/cli.js apply <graph.jsonl> [--out state.json]   # 默认写 stdout
node src/cli.js query <q.dsl> --graph <state.json>
node src/cli.js verify <cert.json> [--graph <state.json>]
```

`cert.json` 可以是单个证书，也可以是 `query` 的完整输出（逐个验证 `certificates`）。

### 退出码（实测）

| 退出码 | 含义 | 示例 |
| --- | --- | --- |
| 0 | 成功（apply/query 完成、verify 全部证书通过） | `verify` 输出 `certificate 0: OK` |
| 1 | 语义/运行时失败：成环、未知批号、事务失败、证书验证不通过 | `graph.jsonl:7: transaction failed: link LOT-2025-0002 -> LOT-2025-0001 would create a cycle` |
| 2 | 格式错误：JSONL/DSL/JSON 解析失败、命令缺字段、参数用法错误，信息带行号写 stderr | `graph.jsonl:2: invalid JSON: …`、`q.dsl:2: unknown function 'nope'` |

## 测试

```sh
node --test
```

最近一次实测输出（Node v22.22.1）：

```
# tests 7        # 7 个测试文件
# pass 7
# fail 0
```

按单个测试计：49 个测试，49 通过，0 失败（`test/` 下 7 个文件分别
6/8/10/7/10/7/1 个）。覆盖验收点：

1. 共享原料的祖先查询去重且排序确定 — `test/query.test.js`
2. 错误 link 撤销后谱系恢复、redo 后证书版本不同 — `test/query.test.js`
3. 成环命令被拒绝且无部分写入 — `test/cli.test.js`、`test/graph.test.js`
4. ≤30 节点随机 DAG 与独立 BFS 参考实现比对 — `test/reference.test.js`
5. 篡改路径验证失败 — `test/cert.test.js`、`test/cli.test.js`

## 目录结构

```
src/schema.js    静态模式：节点属性、边类型、批号/日期校验
src/graph.js     谱系图：事务、undo/redo、防环、序列化
src/lexer.js     DSL 词法分析（批号/日期/字符串/行号）
src/parser.js    Pratt 解析器（过滤表达式优先级）
src/compiler.js  AST → 字节码，let 词法作用域与静态类型检查
src/vm.js        字节码虚拟机，结果与证书生成
src/cert.js      证书重算验证
src/cli.js       apply / query / verify 命令行
```
