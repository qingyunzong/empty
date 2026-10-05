# clearing-net

金融清算网络可行性判定库与 CLI。网络中每条边带有下界（必须完成的结算量）
和上界（最多可承载的结算量）。在任意 `add-edge` / `update-edge` /
`remove-edge` 变更（含按事件 ID 的 `undo` / `redo`）之后，判断是否存在
满足所有节点流入等于流出的环流：

- 可行时返回每条边的结算量（整数流，满足下界 <= 流量 <= 上界且节点守恒）；
- 不可行时返回差额节点与违反的最小割证书（Hoffman 环流条件：存在节点
  集合 X，其入边下界之和 > 出边上界之和），且不产生伪流。

仅使用 Node.js 22 标准库；测试基于 `node:test`。

## 库用法

```js
import { ClearingNetwork } from 'clearing-net';

const net = new ClearingNetwork();
net.addEdge('evt-1', { id: 'e1', from: 'A', to: 'B', lower: 2, upper: 5 });
net.addEdge('evt-2', { id: 'e2', from: 'B', to: 'A', lower: 2, upper: 5 });
net.status();
// { feasible: true, flow: { e1: 2, e2: 2 } }
net.undo('evt-2');
net.status();
// { feasible: false, deficitNodes: ['B'],
//   certificate: { cut: ['B'], lowerBoundIn: 2, upperBoundOut: 0, deficit: 2 } }
net.redo('evt-2'); // 恢复可行
```

底层算法亦可直接使用：

```js
import { checkCirculation } from 'clearing-net/circulation';
checkCirculation(['A', 'B'], [{ id: 'e1', from: 'A', to: 'B', lower: 5, upper: 10 }]);
```

## CLI

`clearing-net`（或 `node src/cli.js`）从 stdin 读取 NDJSON，每行一个命令，
每个命令在 stdout 输出一行 JSON 响应。

### 命令

```json
{"op":"add-edge","event":"e1","id":"a","from":"A","to":"B","lower":1,"upper":3}
{"op":"update-edge","event":"e2","id":"a","upper":5}
{"op":"remove-edge","event":"e3","id":"a"}
{"op":"undo","id":"e3"}
{"op":"redo","id":"e3"}
{"op":"check"}
{"op":"node-flow","id":"A"}
```

- 每个变更命令必须携带唯一的 `"event"` id；`undo` / `redo` 的 `"id"` 指向
  目标事件。`undo` 只能撤销最近一条已应用事件，`redo` 只能重做最近一条
  已撤销事件，ID 不匹配即报错。新变更会清空可重做栈。
- `update-edge` 的 `lower` / `upper` 至少提供一个，未提供的字段保持原值。
- 变更、`undo`、`redo`、`check` 的响应均包含最新的可行性判定。

### 响应

可行：

```json
{"ok":true,"event":"e2","feasible":true,"flow":{"a":2,"b":2}}
```

不可行（不含 `flow`，不产生伪流）：

```json
{"ok":true,"feasible":false,"deficitNodes":["B"],"certificate":{"cut":["B"],"lowerBoundIn":5,"upperBoundOut":0,"deficit":5}}
```

### 错误

任何错误（下界大于上界、负容量、未知边、未知节点、undo/redo 不匹配、
重复事件 ID、非法 JSON 等）都会向 **stderr** 输出一行 JSON 并以退出码 1
终止：

```json
{"ok":false,"error":{"code":"INVALID_BOUNDS","message":"lower bound 5 exceeds upper bound 3","line":1}}
```

错误码：`INVALID_JSON`、`INVALID_COMMAND`、`INVALID_BOUNDS`、
`NEGATIVE_CAPACITY`、`EDGE_EXISTS`、`UNKNOWN_EDGE`、`UNKNOWN_NODE`、
`DUPLICATE_EVENT`、`UNDO_MISMATCH`、`REDO_MISMATCH`、
`NOTHING_TO_UNDO`、`NOTHING_TO_REDO`。

## 测试

```sh
node --test
```

测试包含：简单环可行且下界被满足；节点外部差额导致不可行并返回证书且
不产生伪流；更新 / undo 后可行性改变；以及容量 <= 10、节点数 <= 7 的
随机图上与暴力枚举（逐边枚举 [lower, upper] 整数流量并检查守恒）的
对照，同时校验返回流的合法性与割证书的真实性。
