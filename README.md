# clearing-house

清算所净额引擎：多机构应收应付指令在持续追加 / 撤销 / 替换下，以依赖图差分维护
秒级更新各机构净额与审计证书，而非全量重算。Node.js 22，仅标准库，测试用 `node:test`。

## 架构

- `src/graph.js` — 动态依赖图：节点为 `instr:<id>` / `bal:<机构>` / `batch`，
  边表示数据流向。支持动态拓扑（新增机构即新增 `bal:` 节点与边、撤销即删边），
  加边前做环检测，`invalidate()` 沿出边做失效传播，`topoOrder()` 给出确定性求值顺序。
- `src/engine.js` — 清算引擎：
  - 差分维护：事件只失效受影响指令 → 相关机构余额 → 净额批次，按拓扑序重算脏节点；
    `naive` 模式每事件全量重算，用于对照（确定性重算与朴素全量一致）。
  - 撤销已入批指令生成反向分录（`kind:"reversal"`, `reverseOf` 指向原哈希），
    原分录与原指令哈希保留在台账中。
  - 幂等：同 id 同版本同载荷 → 无操作；同版本不同载荷 → `CONFLICT`；低版本 → 忽略；
    高版本 → 替换（反向分录冲旧 + 新分录）。
  - 金额整数分：内部用 BigInt 求和，超出安全整数范围抛 `OVERFLOW`，非整数抛 `INVALID_AMOUNT`。
  - 证书：`sha256( canonical({batchSeq, prev, event, nets, entries}) )` 哈希链，完全确定。
- `src/store.js` — 持久化：事件先落 `journal.jsonl`（append + fsync），批次快照写
  `batch-NNNNNN.json.tmp` + fsync + `rename` 原子替换 + 目录 fsync。
  崩溃恢复：忽略 `*.tmp` 半成品，加载最新完整批次快照，重放其后的日志事件；
  容忍日志最后一行被截断。
- `src/cli.js` / `bin/clearing.js` — CLI：stdin 读 JSONL 事件，每事件后 stdout 输出
  一行 `{seq, changed, batchSeq, nets, certificate}`；错误写 stderr 并以码 2 退出。

## 事件格式

```json
{"type":"submit","id":"i1","version":1,"payer":"A","payee":"B","amountCents":500,"dependsOn":["i0"]}
{"type":"revoke","id":"i1"}
```

`dependsOn` 可省略；指令间依赖构成 DAG，成环即拒绝（`CYCLE`，退出码 2）。

## 运行测试

```sh
node --test
```

真实结果（2026-10-04，Node v22.22.1）：`# tests 4 / # pass 4 / # fail 0`
（4 个测试文件：engine 11 项、store 3 项、cli 4 项、helpers；含撤销后恢复、
循环依赖拒绝、400 事件随机增量 vs 朴素全量 vs 暴力对照、快照恢复一致性、
写批次中途 SIGKILL 重启无半批次、日志截断容忍、CLI 错误码。）

## CLI 复现

```sh
printf '%s\n' \
'{"type":"submit","id":"i1","version":1,"payer":"A","payee":"B","amountCents":500}' \
'{"type":"submit","id":"i2","version":1,"payer":"B","payee":"C","amountCents":200}' \
'{"type":"revoke","id":"i1"}' \
'{"type":"submit","id":"i1","version":2,"payer":"A","payee":"B","amountCents":500}' \
| node bin/clearing.js
```

真实输出（每事件一行，撤销后净额归零、v2 恢复）：

```
{"seq":1,"changed":true,"batchSeq":1,"nets":{"A":-500,"B":500},"certificate":"f5e36d89..."}
{"seq":2,"changed":true,"batchSeq":2,"nets":{"A":-500,"B":300,"C":200},"certificate":"7cf90004..."}
{"seq":3,"changed":true,"batchSeq":3,"nets":{"A":0,"B":-200,"C":200},"certificate":"116bf6fb..."}
{"seq":4,"changed":true,"batchSeq":4,"nets":{"A":-500,"B":300,"C":200},"certificate":"7084796e..."}
```

故障注入（写批次文件中途 kill，重启不得出现半批次）：

```sh
CLEARING_TEST_CRASH_DURING_BATCH_WRITE=1 node bin/clearing.js --state-dir /tmp/demo < events.jsonl
# 进程被 SIGKILL（exit 137），state 目录只剩 batch-000001.json.tmp 半成品与 journal.jsonl
node bin/clearing.js --state-dir /tmp/demo < events.jsonl
# 重启后从日志恢复，exit 0；目录中 batch-*.json 均为完整 JSON，最终 nets {"X":0,"Y":-40,"Z":40}
```

循环依赖拒绝（退出码 2，错误写 stderr）：

```sh
printf '%s\n%s\n' \
'{"type":"submit","id":"s","version":1,"payer":"A","payee":"B","amountCents":5}' \
'{"type":"submit","id":"s","version":2,"payer":"A","payee":"B","amountCents":5,"dependsOn":["s"]}' \
| node bin/clearing.js
# stdout 第 1 行正常；stderr: error: CYCLE: dependency s -> s would create a cycle；exit=2
```
