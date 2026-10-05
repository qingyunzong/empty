# bitplanner

有限动作规划器：至多 12 个布尔状态位 + 有限资源，单位动作成本，
TypeScript 编写，仅依赖 Node.js 内置库（零 npm 依赖）。

## 构建与测试

```sh
npm test        # tsc 编译 + node --test（42 个子测试）
npm run cli -- <args>   # 编译并运行 CLI
```

## 问题模型（JSON）

- `numBits`: 1..12 个布尔位；`initial.bits` 为位掩码整数。
- `resources`: 有限资源 `[{name, max, initial}]`，取值恒在 `[0, max]`。
- `goal`: 条件 `{bits: {i: 0|1}, resources: [{index, op, value}]}`。
- `actions`: `[{name, pre, effects}]`；效果可带 `when`（条件效果）、
  `set`（位赋值）、`res`（资源增减）。
- **同时效果按旧状态求值**：同一动作所有 `when` 与效果均在动作前状态上
  求值，结果一次性提交。
- **互斥效果拒绝**：加载时静态拒绝可能同时触发且对同一位冲突赋值的效果
  （条件互相矛盾者除外）；运行时动态冲突抛 `MutexError`。

## CLI

```sh
node dist/src/cli.js solve   examples/lights.json --cert cert.json   # BFS 最短 + 证书
node dist/src/cli.js verify  examples/lights.json cert.json          # 独立校验证书
node dist/src/cli.js closure examples/robot.json                     # 完整可达闭包
node dist/src/cli.js learn   examples/lights.json                    # 回溯学习
node dist/src/cli.js bounds  examples/robot.json                     # A* + 可检查下界
node dist/src/cli.js solve   examples/robot.json --pause-after 2 --snapshot snap.json
node dist/src/cli.js resume  examples/robot.json snap.json           # 恢复后继续
```

## 设计要点

- **最短证书**：证书含动作序列与 BFS 各层前沿大小；校验方独立重放计划
  并重算 BFS 层，确认目标深度之前无目标态（最优性可检查）。
- **可达闭包**：完整 BFS 枚举全部可达状态及深度直方图。
- **回溯学习（`src/learning.ts`）**：仅当一个状态的所有可用后继都已被
  证明不可达目标时才记为 nogood；处于当前 DFS 路径上的后继（环）使状态
  标记为 UNKNOWN 而非 dead——已学 nogood 绝不排除未探索的可行路径。
  测试以反向 BFS 精确目标距离核对：`nogoods ∩ canReachGoal = ∅`。
- **可序列化前沿（`src/frontier.ts`）**：BFS/A* 统一引擎，优先级
  `(g 或 g+h, 插入序号)` 完全确定；快照含 open 堆、closed、父指针、
  最佳 g、计数器与访问日志，JSON 往返后恢复运行的访问顺序与未暂停
  运行逐点一致（测试覆盖多个暂停点与随机问题）。
- **可检查下界（`src/heuristic.ts`）**：`h(s) = ceil(缺失目标位 / maxFix)`，
  `maxFix` 为单动作最多可修正的目标位数（可采纳且一致）；A* 对每个扩展
  节点输出 `{key, g, h, f}` 记录，`verifyLowerBounds` 用完整 BFS 的精确
  目标距离逐条核对 `h ≤ dist`；随机小问题上 A* 长度与 BFS 最优一致。

## 实际测试结果（Node v22.22.1, tsc 7.0.2）

```
$ npm test
ok 1 - dist/test/bfs.test.js        (6 子测试)
ok 2 - dist/test/cli.test.js        (7 子测试)
ok 3 - dist/test/frontier.test.js   (5 子测试)
ok 4 - dist/test/heuristic.test.js  (6 子测试)
ok 5 - dist/test/learning.test.js   (6 子测试)
ok 6 - dist/test/model.test.js      (12 子测试)
# pass 42  # fail 0
```

端到端实测：

```
$ node dist/src/cli.js solve examples/lights.json --cert /tmp/cert.json
shortest plan (4 steps): set0 -> set1 -> set2 -> set3
layers: [1, 1, 1, 2, 2], reachable: 8
$ node dist/src/cli.js verify examples/lights.json /tmp/cert.json
certificate OK: plan reaches goal and is shortest
$ node dist/src/cli.js closure examples/robot.json
reachable states: 20
depth histogram: [1, 3, 4, 3, 2, 2, 2, 2, 1]
$ node dist/src/cli.js bounds examples/robot.json
A* plan (3 steps): load -> move -> deliver
expanded: 9 nodes; lower-bound violations: 0
$ node dist/src/cli.js solve examples/robot.json --pause-after 2 --snapshot /tmp/snap.json
paused after 2 expansions; snapshot -> /tmp/snap.json
$ node dist/src/cli.js resume examples/robot.json /tmp/snap.json
resumed; total expansions 10
plan (3 steps): load -> move -> deliver
$ node dist/src/cli.js solve examples/mutex-bad.json
error: action "conflict": effects 0 and 1 can fire together and conflict on bit 0 (mutex rejected)   # 退出码 1
```
