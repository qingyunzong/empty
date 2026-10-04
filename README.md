# logtopo

多源日志因果拓扑排序 CLI。TypeScript + Node.js 内置库（零运行时依赖）。

## 功能

- **拓扑序输出**：每轮从候选集中选择 `(时间戳, 源ID, 序号)` 最小者（id 兜底）。
  时间戳仅作优先级，不要求因果单调——因果边优先于时间戳。
- **缺依赖证据**：报告 `事件 -> 未知依赖`，并传递性标记被阻塞事件；缺失依赖索引
  `missingDep -> [eventIds]` 随快照保存。
- **环证据**：Kahn 算法剩余节点中 DFS 提取具体环路径（如 `x -> z -> x`）。
- **小图枚举核对**：回溯枚举全部拓扑序，验证贪心序是其中之一（有环图无线性扩展，跳过）。
- **增量因果修订**：已发布前缀固定；新依赖若要求倒置前缀（或引入环），整批原子拒绝，
  并给出最短冲突链（BFS：`u -> ... -> 已发布事件`）；未发布区域自由重排。
- **快照**：保存事件、已发布前缀、候选集（ready frontier）与缺依赖索引；
  恢复时与全量重算核对（完整性校验）。
- **随机修订对全图重建**：`test/random.test.ts` 用确定性 PRNG 生成随机修订，
  逐步比对增量结果与全图重建，并穿插快照往返。

## 构建与测试

```sh
npm test   # tsc 编译 + node --test（使用全局 tsc，无需 npm install）
```

## CLI

```sh
node dist/src/cli.js sort <log.jsonl|json> [--enumerate] [--limit N]
node dist/src/cli.js init <log.jsonl> --out snap.json
node dist/src/cli.js publish <snap.json> <n> --out snap2.json
node dist/src/cli.js revise <snap.json> <batch.json> --out snap3.json
node dist/src/cli.js show <snap.json>
```

输入为 JSONL（每行一个事件）或 JSON 数组：

```json
{"id":"a1","source":"A","seq":1,"ts":100,"deps":["b1"]}
```

修订批次：

```json
{"events":[...], "deps":[{"id":"a1","dep":"b1"}], "publish":2}
```

## 测试结果（实际运行）

```
$ npm test
# tests 5  (dist/test/*.test.js: topo / enumerate / revision / snapshot / random)
# pass 5
# fail 0
```
