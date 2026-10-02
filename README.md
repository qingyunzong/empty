# press-scheduler

单机离线冲压车间排产库与 CLI（Node.js 22，零依赖，全程 BigInt 有理数运算，禁止浮点）。

## 模型

- 任务：`{id, release, deadline, duration, weight}`，时间/权重均为 `p/q` 有理数。
- 任务不可抢占，可在 `[release, deadline-duration]` 内任意有理数时刻开始。
- 单机同一时刻只能执行一个任务；执行区间端点相切（`end == start`）允许连续安排。
- 目标：最大化已选任务权重和；并列时选已选 id 排序后字典序最小的集合。
- 证书：每个未选任务列出与其窗口正长度相交的所有已选任务 id（相切不算冲突）。

## 有理数输入

接受 `"p/q"`、`"p"`、整数、`{"p":..,"q":..}`。非整数浮点一律拒绝（`E_RATIONAL`）。
输出统一为约分后的 `"p/q"` 字符串（分母为 1 时输出 `"p"`）。

## 错误约定

| 条件 | 错误码 |
| --- | --- |
| 分母为 0 / 非法有理数 / 浮点 | `E_RATIONAL` |
| `release > deadline` | `E_EMPTY` |
| `duration <= 0` | `E_EMPTY` |
| id 缺失或类型错误 | `E_SCHEMA` |
| 重复 add / 更新或删除不存在的 id | `E_DUP` / `E_NOTFOUND` |
| 无可撤销/重做 | `E_UNDO` / `E_REDO` |

非法 `add`/`update` 不产生新版本，当前状态不变。

## 库用法

```js
import { Scheduler } from './src/scheduler.js';
const s = new Scheduler();
s.add({ id: 'a', release: '0', deadline: '1', duration: '1/2', weight: '2' });
s.update('a', { weight: '3' });   // 只替换给定字段
s.remove('a'); s.undo(); s.redo();
s.solve(); // { ok, version, weight, jobs:[{id,start,end}], certificate }
```

## CLI

从 stdin 读取 JSON 命令序列（数组或 NDJSON），stdout 输出单行 JSON 结果数组：

```sh
echo '[{"op":"add","task":{"id":"a","release":"0","deadline":"1","duration":"1","weight":"1"}},
       {"op":"solve"}]' | node cli.js
```

命令：`add` / `update`（`patch` 或 `task` 携带字段）/ `remove` / `undo` / `redo` / `solve` / `state`。

## 求解正确性

- 可行性：对子集 S 做精确 DP，`f(S) = min over 末任务 t of max(f(S\{t}), r_t) + p_t`
  （受 `d_t` 约束），即该子集最早完工时间；有限即可行。
- 优化：按 id 序分支定界枚举子集，上界为当前权重加剩余正权重和；
  权重相等时保留字典序最小的 id 集合。
- 测试中以 `n<=8` 的全子集 × 全排列枚举作为参照交叉验证。

## 测试

```sh
node --test
```
