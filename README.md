# evidence-chain

证据链系统：记录事实（fact）、来源（source）与派生结论（derived），支持撤销来源后
自动降级派生结论、恢复来源后回到可证明状态。Node.js 22，仅标准库，单机离线。

## 数据模型

- **fact**：`{id, source, value?}`，来自某个 source 的事实，value 默认为 1。
- **source**：事实的来源，可被 revoke / restore（均为可逆事件）。
- **derived**：`{id, op: count|sum, min, inputs[]}`，对有向证据图上游节点做支持度聚合。

## 状态语义

- fact：`valid` / `revoked`（来源被撤销）/ `deleted`（被删除，墓碑事件）。
- derived：
  - `valid`：所有输入 valid 且聚合支持度 ≥ min；
  - `degraded`：部分输入失效（revoked/deleted/degraded）或支持度不足——结论被削弱；
  - `unknown`：任一输入为 unknown（引用了不存在的节点）。
    **unknown 不当不可满足处理**：它在聚合中向上传播为 unknown，
    既不计入支持度，也不会把父节点判为 degraded。
- 聚合：`count` = valid 输入个数；`sum` = valid 输入的值之和
  （fact 取其 value，derived 取其支持度，可沿链累积）。

## 持久化：WAL + 快照

目录结构（默认 `.evidence/`，可用 `--dir` 或 `EVIDENCE_DIR` 指定）：

- `wal.log`：追加式事件日志，每行一个事件
  `{seq, ts, type, payload, prev, hash}`，`hash = sha256(stableStringify({seq,ts,type,payload,prev}))`，
  构成哈希链（genesis prev 为 64 个 0）。
- `snapshot.json`：`{seq, hash, state, checksum}`，checksum 为内容哈希；tmp+rename 原子写入。
- `index.json`：索引检查点 `{appliedSeq, appliedHash}`，仅作一致性参照，损坏可重建。

### 故障点（崩溃注入钩子，`Store.open(dir, {faults})`）

- **FP1 `afterAppend`**：事件已追加到 WAL、内存索引未更新。
  恢复时从 WAL 重放该事件。
- **FP2 `beforeIndex`**：内存索引已更新、索引检查点未持久化（可能留下损坏的
  index.json）。恢复时忽略损坏检查点，从快照 + WAL 重建索引。
- **FP3 `afterSnapshot`**：快照已提交、WAL 尚未压缩（含已入快照的事件）。
  恢复时跳过 `seq <= snapshot.seq` 的事件，重放幂等。

### 恢复流程

1. 加载最新快照并校验 checksum（不符 → `E_HASH`）。
2. 逐行读 WAL：验证每个事件哈希与链式 prev（不符 → `E_HASH`）；
   seq 必须连续（断档 → `E_WAL`）；首事件 seq 为 1 或 `snapshot.seq+1`，
   压缩后的 WAL 首事件 prev 必须等于快照哈希。
3. 末尾撕裂行（崩溃残留）截断修复；中间损坏行 → `E_WAL`。
4. 索引检查点若领先 WAL → `E_WAL`；损坏则忽略重建。
5. 从快照状态重放 `seq > snapshot.seq` 的事件，结果确定。

`verifylog` 为严格只读校验：不修复，撕裂尾行同样报 `E_WAL`。

## 错误码

| 代码 | 含义 | CLI 退出码 |
|---|---|---|
| `E_CYCLE` | derive 会引入依赖环 | 2 |
| `E_SOURCE_GONE` | revoke/restore 不存在的来源 | 3 |
| `E_WAL` | WAL 损坏/断档/索引不一致 | 4 |
| `E_HASH` | 哈希链或快照校验失败 | 5 |

## CLI

```
evidence [--dir PATH] add <fact.json>      # {"id":"f1","source":"s1","value":1}
evidence [--dir PATH] derive <rule.json>   # {"id":"d1","op":"count|sum","min":N,"inputs":[...]}
evidence [--dir PATH] remove <factId>      # 删除事实（墓碑事件）
evidence [--dir PATH] revoke <sourceId>
evidence [--dir PATH] restore <sourceId>
evidence [--dir PATH] status <node>        # {"node","status","support"?}
evidence [--dir PATH] snapshot
evidence [--dir PATH] verifylog
```

库用法：`import { Store } from './index.js'`，`Store.open(dir)`、
`append(type, payload)`、`status(id)`、`snapshot()`、`verify()`。

## 验收对照

1. **层级撤销影响三级派生** — `test/acceptance.test.js`：
   f→d1→d2→d3，撤销来源后三级全部 degraded，恢复后全部 valid。
2. **恢复不复活被后续删除的事实** — `test/acceptance.test.js`：
   revoke → delete → restore 后事实仍为 deleted，派生保持 degraded。
3. **100 节点内与参考闭包枚举对照** — `test/closure.test.js`：
   20 个随机种子、≤100 节点随机 DAG，库求值与独立的定点枚举参考实现
   在内存态、WAL 重放、快照恢复三种路径下结果完全一致。
4. **三故障点注入恢复结果确定** — `test/recovery.test.js`：
   FP1/FP2/FP3 各注入崩溃（每点重复 2 轮），恢复结果确定且 verifylog 通过；
   另有撕裂尾行截断与跨运行确定性测试。

## 测试

`node --test`（或 `npm test`）。真实运行结果（Node v22.22.1）：

```
# tests 7（6 个测试文件 + helpers，共 22 个子测试）
# pass 7
# fail 0
```

- test/graph.test.js：聚合 count/sum、unknown 传播、事实状态（5 项）
- test/acceptance.test.js：验收 1、2（2 项）
- test/closure.test.js：验收 3（1 项，20 种子）
- test/recovery.test.js：验收 4 + 撕裂尾行（5 项）
- test/errors.test.js：E_CYCLE / E_SOURCE_GONE / E_WAL / E_HASH（6 项）
- test/cli.test.js：CLI 端到端、退出码、remove 语义（3 项）
