# agv-router

离线单机、仅 Node.js 22 标准库实现的动态最短路径库与 JSONL CLI，面向工厂夜班
AGV 调度：边可随时封闭 / 重开 / 改权，查询持续返回从装卸口到工位的最短可行
路径，并附带可独立核验的最优性证书。

## 文件

- `src/graph.js` — 库：`DynamicGraph`、`GraphError`、`ERRORS`、`comparePaths`
- `cli.js` — JSONL CLI（stdin 读命令，stdout 逐行回 JSON）
- `test/graph.test.js`、`test/cli.test.js` — `node:test` 测试
- `RESULTS.md` — 真实测试运行结果

## 命令（JSONL，每行一个对象）

```json
{"op":"add_edge","id":"e1","from":"DOCK","to":"WS1","cost":4}
{"op":"close","id":"e1"}
{"op":"open","id":"e1"}
{"op":"set_cost","id":"e1","cost":7}
{"op":"query","from":"DOCK","to":"WS2"}
{"op":"undo"}
{"op":"verify","cert":{...}}
```

- 图为**有向图**，`cost` 必须是非负有限数；`id` 缺省时自动生成。
- `query` 成功返回 `{"ok":true,"path":[...],"cost":c,"cert":{...}}`；
  同权并列路径按节点序列字典序稳定输出。
- `undo` 回退最近一条未提交的变更（add_edge/close/open/set_cost），
  连续 undo 逐层回退；已输出的查询结果不受影响（证书按图版本核验）。
- 错误码：`INVALID_INPUT`（参数/JSON 非法）、`NO_PATH`（真正断连）、
  `CONFLICT`（边 id 重复或无可 undo）、`CERT_INVALID`（证书伪造/过期/版本不符）、
  `UNDECIDED`（保留；本实现查询为精确全量计算，不会把未计算完当作不可达）。

## 最优性证书

`cert = {version, from, to, cost, path, dist}`，其中 `dist` 是到达势
（各节点最短距离标号，即割界数据）。`verify` 独立核验：

1. `version` 与当前图版本一致（任何变更/undo 都会递增版本，过期即拒）；
2. `dist[from]=0` 且对每条开放边 `(u,v,w)` 满足 `dist[v] <= dist[u] + w`
   —— 证明任何 `from→to` 走法的成本下界为 `dist[to]`；
3. `path` 首尾正确、每段边存在且开放、相对势严格紧贴
   （`dist[v]-dist[u]` 等于某条开放边权），总和等于 `cost` —— 达到下界。

任一条件不满足（伪造、篡改、过期、版本不符）均抛 `CERT_INVALID`。

## 运行

```sh
node cli.js < commands.jsonl   # CLI
node --test                    # 测试
```

规模：`n<=200, m<=3000, 命令<=5000` 下全量混合负载约 4 秒（见 RESULTS.md）。
