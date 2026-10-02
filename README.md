# agv-chain

仓储 AGV 调度的离线任务链重建与证书导出工具。Node.js 22，仅标准库，单机离线，无第三方依赖。

## 用法

```sh
node cli.js ev.jsonl --cert c.json     # 写证书到 c.json
node cli.js ev.jsonl                   # 证书输出到 stdout
node cli.js ev.jsonl --timeout 60000   # PICK->DROP 超时阈值（毫秒，默认 30000）
node --test                            # 运行测试
```

## 事件格式（JSONL）

每行一个 JSON 对象；同一报文可分帧跨多行，解析器会自动重组。重复、乱序报文会被去重并按 `seq` 重排。

```json
{"type":"ASSIGN","job":"B","leg":0,"seq":1,"causes":[{"job":"A","leg":0}],"ts":400}
```

- `type`: `ASSIGN` / `PICK` / `DROP` / `FAIL` / `RETRY`
- `job`: 任务 id；`leg`: 任务内腿号；`seq`: 任务内序号；`ts`: 事件时间（虚拟时钟）
- `causes`: 跨 job 因果边，元素为 `"job:leg"` 字符串或 `{"job","leg"}` 对象

## 语义

- **链重建**: 同 job 事件按 `seq` 排序；同 job 相邻 leg 之间、以及 `causes` 指向的 leg 之间建有向边。
- **RETRY**: 必须紧跟该 job 最近的 `FAIL`，且必须开启新 leg；旧 leg 在 `FAIL` 后封闭，任何后续事件修改旧 leg 都会被拒绝。
- **根因分析**: `FAIL` 被补偿 = 其后续存在 `RETRY` 且该 job 最终 leg 到达 `DROP`。输出"最早未补偿 FAIL 集合"：未补偿且其 causes 祖先中没有其他未补偿 FAIL 的节点。
- **成环**: causes 图（含 job 内 leg 边）出现环时拒绝整批。
- **stale**: 虚拟时钟（批内最大 `ts`）越过 `pick.ts + timeout` 仍无匹配 `DROP` 的 `PICK` 标记为 stale；迟到的 `DROP`（`drop.ts > pick.ts + timeout`）会证伪并撤销标记，但 `staleLog` 记录保留。
- **证书**: 含 `chainHash`（链结构 + 边 + 根因 + staleLog 的规范化 SHA-256）、`rootCauses`、`staleLog`（含撤销记录）、统计信息。`ChainBuilder` 支持增量 `ingest`，每次 `certificate()` 反映当前状态。

## 退出码

| 码 | 含义 |
|----|------|
| 0  | 成功 |
| 1  | 输入/格式错误 |
| 2  | 参数错误 |
| 14 | causes 成环，整批拒绝 |
| 15 | 非法 RETRY（未接 FAIL / 复用旧 leg / 修改封闭 leg） |

## 库 API

```js
const { ChainBuilder } = require('./src/chain');
const { parseFrames } = require('./src/events');

const b = new ChainBuilder({ timeout: 30000 });
b.ingestAll(parseFrames(require('fs').readFileSync('ev.jsonl', 'utf8')));
b.ingest({ type: 'DROP', job: 'A', leg: 0, seq: 3, causes: [], ts: 1500 });
const cert = b.certificate();
```

## 测试结果（真实运行记录）

环境：Node.js v22.22.1，Linux x86_64。

```
$ node --test
# tests 2 (test/chain.test.js, test/cli.test.js)
# pass 2
# fail 0
```

子测试共 13 项全部通过（chain 9 项 + cli 4 项），覆盖验收点：

1. 重复 + 乱序报文重建链哈希与参考一致（`duplicates + out-of-order input rebuild the reference chain`）
2. stale 被迟到 DROP 证伪、日志保留、证书增量更新（`stale pick falsified by late DROP, certificate updates incrementally`）
3. RETRY 接非 FAIL / 复用旧 leg / 修改封闭 leg 均以 exit 15 拒绝
4. 小规模 causes 枚举（64 × 4 × 16 = 4096 个无环图）根因与独立暴力参考实现逐一比对一致

示例：`node cli.js examples/ev.jsonl --cert c.json` 输出
`ok: 11 events, 3 jobs, 4 legs, 0 root cause(s), 0 stale record(s), hash 43ae0b2bd1ed300f...`
