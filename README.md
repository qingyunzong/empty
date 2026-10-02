# lineage-graph

食品工厂谱系库 + 查询 DSL + CLI。追踪原料（raw_material）、半成品（intermediate）、
成品批次（product）之间的 `feeds_into` 关系，支持事务化录入、undo/redo、
有向环拒绝、以及带防篡改证书的谱系查询。Node.js 22，仅标准库，单机离线。

## 快速开始

```sh
node bin/lineage.js apply examples/graph.jsonl --state state.json
node bin/lineage.js query examples/q.dsl --graph state.json --cert cert.json
node bin/lineage.js verify cert.json
```

## CLI

| 命令 | 说明 |
| --- | --- |
| `lineage apply <graph.jsonl> [--state state.json]` | 逐行应用命令，全部成功后一次性写状态文件 |
| `lineage query <q.dsl> --graph state.json [--cert cert.json]` | 编译并执行查询，stdout 输出有序结果，证书写入 `--cert`（默认 `cert.json`） |
| `lineage verify <cert.json>` | 重算证书内所有哈希并校验 |

**退出码**（真实验证过，见下文“测试结果”）：

- `0` 成功（verify 输出 `OK`）
- `1` 证书验证失败（含路径/命令日志被篡改）或查询运行时错误（如引用不存在的批号）
- `2` 格式错误：JSONL/DSL 语法或语义错误、状态文件损坏、参数缺失。
  错误带行号写 stderr，如 `graph.jsonl:2: error: link: ... would create a directed cycle`

## 命令格式（graph.jsonl）

每行一个 JSON 命令；`#` 开头与空行跳过：

```json
{"op":"add","id":"LOT-2025-0001","type":"raw_material","props":{"name":"Flour","date":"2025-01-05"}}
{"op":"link","from":"LOT-2025-0001","to":"LOT-2025-0003"}
{"op":"unlink","from":"LOT-2025-0001","to":"LOT-2025-0003"}
{"op":"begin"} / {"op":"commit"} / {"op":"undo"} / {"op":"redo"}
```

- `begin`…`commit` 之间的命令构成一个事务：任一命令失败（如成环、重复批号、
  违反静态模式），整个事务回滚，无部分写入；整个文件失败时状态文件不变。
- `undo`/`redo` 以事务为单位回退/重做历史，每次操作图版本号 +1。
- `link` 默认边类型 `feeds_into`（可用 `"edge"` 字段指定），禁止形成有向环。

## 静态模式（src/schema.js）

- 节点类型：`raw_material` / `intermediate` / `product`
- 边类型：`feeds_into`，仅允许 `raw_material|intermediate -> intermediate|product`
- 属性：`name`(string)、`date`(YYYY-MM-DD)、`quantity`(number)、`supplier`(string)
- 批号词法：`^[A-Z][A-Z0-9]*-\d{4}-\d{4}$`，如 `LOT-2025-0001`

## 查询 DSL

```
let base = ancestors(LOT-2025-0005);
{
  let raw = base where type == "raw_material";   # let 具词法作用域，块内遮蔽块外
  raw where date >= 2025-01-01 and not (quantity < 10) order by id desc;
}
shortestPath(LOT-2025-0001, LOT-2025-0005);
```

- 词法层识别批号（`LOT-2025-0001`）、日期（`2025-01-15`）、字符串、数字。
- 源：`ancestors(x)`、`descendants(x)`、`shortestPath(a, b)`、`nodes()`、变量、批号字面量。
- `where` 过滤表达式由 Pratt 解析器处理，优先级：`or` < `and` < 比较 < `not`，支持括号。
- `order by <prop> asc|desc`；缺省按 `id` 升序，结果去重且排序确定。
- 查询编译为字节码（`src/compiler.js`）后在 VM（`src/vm.js`）上执行。

## 证书

`query` 输出的证书（JSON）包含：

- `commandsHash`：输入命令日志（事务历史）的 SHA-256（规范化 JSON）
- `graphVersion`：查询时的图版本
- `pathHashes`：每条结果（集合或路径）节点列表的哈希
- `certHash`：以上所有字段整体的哈希

`verify` 重算全部哈希并比对；证书深拷贝签发，之后的 undo/redo 不影响已签发证书。
篡改路径节点、命令日志或查询文本都会使验证失败（exit 1）。

## 测试

```sh
node --test
```

最近一次运行：**27 个测试全部通过，0 失败**（5 个测试文件）：

- `test/lexer.test.js` 4 通过 / 0 失败
- `test/parser.test.js` 6 通过 / 0 失败
- `test/graph.test.js` 5 通过 / 0 失败
- `test/query.test.js` 6 通过 / 0 失败
- `test/acceptance.test.js` 6 通过 / 0 失败（对应 5 条验收标准 + CLI 退出码）

验收标准覆盖：① 共享原料的祖先查询去重且排序确定；② 错误 link 撤销后谱系恢复、
redo 后证书图版本不同；③ 成环命令被拒绝且事务无部分写入；④ ≤30 节点随机 DAG
与独立 BFS 参考实现比对（ancestors/descendants/shortestPath）；⑤ 篡改路径验证失败。

退出码经真实 shell 验证：`apply/query/verify` 成功为 0，篡改证书 `verify` 为 1，
非法 JSONL / DSL 语法错误 / 缺参数为 2（行号写 stderr）。

注：沙箱内禁止 Node 派生子进程，CLI 测试通过进程内调用 `main()` 完成——
`main()` 返回的退出码即 `bin/lineage.js` 赋给 `process.exitCode` 的值。
