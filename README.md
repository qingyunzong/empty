# event-bus-replay

离线单机的事件总线回放库与 CLI（仅 Node.js 22 标准库，无第三方依赖）。
合并多源设备事件为因果偏序，判断报警是否由前序故障因果导致，并识别
传感器配置中的循环依赖。

## 语义

- `observe(id, ts, node)`：登记事件。重复 id、非法 ts/node 报 `INVALID_INPUT`。
- `link(a, b, kind)`：建立有向边 a -> b（缺端点报 `INVALID_INPUT`）。
- `query(a, b)`：
  - `REACHABLE`：给定偏序中存在 a -> b 路径；
  - `NOT_REACHABLE`：b -> a 已确立，或 ts(a) > ts(b) 物理时序排除 a -> b；
  - `CONCURRENT`：同一物理时刻且无给定先后（未知先后不当矛盾）；
  - `UNDECIDED`：ts(a) < ts(b) 但双向都无路径，a -> b 可能经由未观测
    链路成立，绝不报 `NOT_REACHABLE`。
- `scc`：输出大小 > 1 的强连通分量，成员字典序排序，分量间确定性排序。
- `checkpoint` / `rollback(k)`：分层检查点。`rollback(k)` 精确撤销最近
  k 层；k 超过层数时状态保持原状并返回 `ROLLBACK_RANGE`；负 k 或非整数
  报 `INVALID_INPUT`。

## CLI

```sh
node bin/cli.js [replay.jsonl]   # 省略文件参数时读 stdin
```

每行一个 JSON 命令，每行输出一个结果：

```jsonl
{"op":"observe","id":"e1","ts":100,"node":"devA"}
{"op":"observe","id":"e2","ts":100,"node":"devB"}
{"op":"link","a":"e1","b":"e2","kind":"cause"}
{"op":"checkpoint"}
{"op":"query","a":"e1","b":"e2"}
{"op":"rollback","k":1}
{"op":"scc"}
```

## 库

```js
import { EventBus, InvalidInputError } from './src/eventbus.js';
const bus = new EventBus();
bus.observe('f1', 90, 'devA');
bus.observe('a1', 110, 'devA');
bus.link('f1', 'a1', 'cause');
bus.query('f1', 'a1'); // 'REACHABLE'
```

## 测试

```sh
node --test
```

规模：事件 <= 4000 时，建图、查询、SCC、回滚均在秒级内完成。
