# keydoor-pathlib

网格路径库：≤10×10 网格，支持钥匙（≤5，`a`-`e`）、单次门（`A`-`E`，与钥匙一一对应）、
可撤销开门与可分叉的状态版本。全状态 BFS 求最短动作路径，并提供路径重放核验。

## 地图字符

| 字符 | 含义 |
| --- | --- |
| `#` | 墙 |
| `.` | 空地 |
| `S` / `G` | 起点 / 终点（各一个） |
| `a`-`e` | 钥匙（走入自动拾取，每种唯一） |
| `A`-`E` | 单次门（需对应钥匙，开门消耗钥匙） |

## API

```ts
import { parseLevel, StateStore, solve, replayPath, verifyPath, keysHeld } from "./src";

const level = parseLevel(["SaA.G", "....."]);

// 最短动作路径（全状态 BFS：位置 × 已拾钥匙 × 已开门）
const r = solve(level)!;          // { actions, goal, explored }

// 路径重放核验
verifyPath(level, r.actions);     // true：全部合法且到达终点
replayPath(level, r.actions);     // { ok, failedAt, final, reachedGoal, trajectory }

// 版本化状态：撤销与分叉
const store = new StateStore(level);
const s0 = store.initial();
const s1 = store.apply(s0, "right")!;   // 拾钥匙，产生新版本
const s2 = store.apply(s1, "right")!;   // 开门，消耗钥匙
store.undo(s2);                          // 回到 s1：门恢复关闭，钥匙返还
const branch = store.apply(store.fork(s1.version), "down")!; // 从 s1 分叉
solve(level, s1, store);                 // 从分叉版本继续求最短路径
```

## 测试

```sh
npm test   # tsc 编译 + node --test 运行全部测试
```
