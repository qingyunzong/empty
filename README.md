# agv-router

工厂夜班 AGV 调度的动态最短路径库与 JSONL CLI。仅使用 Node.js 22 标准库，离线单机运行。

## 模型

- 地图为**无向正整数权图**，边可随时 `add_edge` / `close`（临时封闭）/ `open`（重开）/ `set_cost`（改权）。
- 每次成功变更（含 `undo`）使图版本号单调 +1；证书绑定签发时的版本。
- 查询在当前状态上完整运行 Dijkstra（二叉堆），**可达即必答**，永不把"尚未算完"报成不可达；`UNDECIDED` 错误码保留但本同步实现不会发出。
- 同权并列路径按节点 id 字符串（UTF-16 码元序）的**字典序最小**稳定输出：用源、汇两侧距离标签贪心构造（`distS[u] + w + distT[v] === 总代价` 的最小邻居）。

## 命令（JSONL，每行一条）

```json
{"cmd":"add_edge","u":"A","v":"B","cost":5}
{"cmd":"close","u":"A","v":"B"}
{"cmd":"open","u":"A","v":"B"}
{"cmd":"set_cost","u":"A","v":"B","cost":7}
{"cmd":"query","from":"A","to":"C"}
{"cmd":"undo"}
{"cmd":"verify","cert":{...}}
```

可选 `"id"` 字段会在对应输出行原样回显。运行：`node src/cli.js [commands.jsonl]`（缺省读 stdin）。

## 输出

- 变更：`{"ok":true,"version":N}`
- 查询：`{"ok":true,"path":[...],"cost":C,"cert":{...}}`
- 不可达：`{"ok":false,"error":"NO_PATH","cert":{...割证书...}}`
- 校验：`{"ok":true}` 或 `{"ok":false,"error":"CERT_INVALID"}`
- 错误码：`INVALID_INPUT`（非法参数/坏 JSON）、`NO_PATH`、`CONFLICT`（重复边、封已封、空栈 undo 等状态冲突）、`UNDECIDED`（保留）、`CERT_INVALID`

## undo 语义

`undo` 只回退**最近一条未提交的变更**（add_edge/close/open/set_cost 的逆操作栈）。查询在应答时即已提交，永不入 undo 栈，因此 undo 不可能改变已发出的查询结果。undo 本身也推进版本号，旧证书不会因状态复原而"复活"。

## 最优性证书（可独立核验）

`path-cert` 含：

- `potentials`（到达势）：Dijkstra 距离标签，即最短路对偶 LP 的可行对偶解；
- `cut`（割界）：`bound = cost` 与所有势 < bound 的节点集合；
- `path` / `cost` / `version`。

`verify` 独立检查：版本匹配；路径真实、边均开放且费用和 = cost；势在**每条开放边**上满足对偶可行性 `pot[v] ≤ pot[u] + w`（双向），`pot[source]=0`、`pot[target]=cost`；割集与势一致。对偶下界与路径上界相等即证最优。任何伪造、过期（签发后有变更）或图版本不符的证书都返回 `CERT_INVALID`。

`nopath-cert` 含 `reachable` 割集：verify 检查源在集内、目标在集外、无开放边跨越割边界，即证断连。

## 规模与测试

规模 n≤200、m≤3000、命令≤5000 下 5000 条混合命令（含 2000+ 次带证书查询与验签）约 5 秒。测试：`node --test`（结果见 RESULTS.md）。
