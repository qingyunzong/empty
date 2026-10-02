# sensor-calibration-chain

传感器观测校准链的增量维护库及 CLI。仅依赖 Node.js 22 标准库与 `node:test`，全程离线。

## 语义

- 每个传感器含原始读数 `raw`、系数 `offset` / `scale`。
- 校准结果沿引用链依次应用 `y = x * scale + offset`：有基准时 `x` 为基准的校准值，否则为自身原始读数。
- 一个传感器至多有一个校准基准；重复设置返回 `E_TOPO`；成环返回 `E_CYCLE`。
- 基准系数更正后，失效沿传递闭包传播，只重算受影响的传感器（见 `stats.recomputed`）。
- 基准缺失或基准 blocked 的传感器：置信度为 0、标记 `blocked`、校准值为 `null`。
- 每个结果输出 `{ id, version, value, confidence, blocked }`。
- 证书 `{ version, coeffHash, topoHash, order }`：系数哈希（SHA-256，按 id 排序的 `[id, offset, scale]`）、拓扑哈希（排序后的 `[id, base]` 边集）、拓扑排序。
- 支持 `undo()` / `redo()`；撤销后发生新更正会清空恢复栈。

## 库

```js
const { CalibrationChain } = require('./src/calibration');
const chain = new CalibrationChain();
chain.addSensor('a', { raw: 2, offset: 1, scale: 3 });
chain.addSensor('b', { raw: 0, offset: 1, scale: 2 });
chain.setBase('b', 'a');
chain.getResult('b');      // { ok: true, result: { id: 'b', version: 3, value: 15, confidence: 1, blocked: false } }
chain.getCertificate();    // { version, coeffHash, topoHash, order }
```

## CLI

```
node src/cli.js < req.json
```

`req.json` 为 `{ "commands": [...] }`（或直接是命令数组）。命令：

| op | 字段 | 说明 |
| --- | --- | --- |
| `addSensor` | `id, raw, offset, scale` | 新增传感器 |
| `removeSensor` | `id` | 删除传感器 |
| `setBase` | `id, base` | 设置校准基准（违反唯一基准 `E_TOPO`，成环 `E_CYCLE`） |
| `removeBase` | `id` | 移除基准 |
| `correct` | `id, offset?, scale?` | 更正系数，失效沿传递闭包传播 |
| `undo` / `redo` | — | 撤销 / 恢复 |
| `result` | `id` | 查询单个结果 |
| `results` | — | 查询全部结果 |
| `certificate` | — | 查询证书 |
| `snapshot` | — | 全部结果 + 证书 |

输出为 `{ "ok": true, "results": [...] }`，每条命令对应一项；失败项含 `error` 码（`E_TOPO` / `E_CYCLE` / `E_UNKNOWN` / `E_STATE` / `E_OP`）。

## 测试

```
node --test
```

测试包含：≤8 传感器下与全量枚举参考实现逐操作比对（校准值、blocked 集合、证书）、基准更换后旧链失效/新链接入、成环、重复基准、撤销至初始、空图稳定性、增量重算范围、CLI 命令分发。
