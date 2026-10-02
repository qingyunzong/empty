# evidence-chain

证据链系统：记录事实（fact）、来源（source）与派生结论（derived conclusion）。
撤销某个来源后，依赖它的派生结论自动降级；恢复来源后回到可证明状态。
Node.js 22，仅标准库，测试使用 `node:test`，单机离线。

## 模型

- **事实 (fact)**：由某个来源断言，携带数值 `value`（默认 1）。来源被撤销时事实降级；
  被 `remove` 的事实留下墓碑（`removed`），之后恢复来源**不会**复活它。
- **派生节点 (rule)**：由前提（premises，可为事实或其他规则）与支持度聚合定义：
  - `count`：有效前提数量 ≥ `threshold`（默认前提数，即 AND）
  - `sum`：有效前提的支持度之和 ≥ `threshold`（默认 1）
- **三值状态**：`valid` / `degraded` / `unknown`。
  `unknown` 表示前提尚未可知（如引用了尚不存在的节点），**绝不**当作不可满足：
  支持度不足但仍有未知前提时，节点为 `unknown` 而非 `degraded`。
- **循环检测**：`derive` 时检查传递依赖，成环（含自环、前向引用闭环）拒绝并报 `E_CYCLE`。
- **可逆事件**：`revoke` / `restore` 都是追加到 WAL 的事件，历史可审计、可重放。

## 持久化：WAL + 快照

数据目录（默认 `.evidence/`，可用 `--dir` 或 `EVIDENCE_DIR` 指定）：

- `wal.log`：逐行 JSON 事件，每条含 `seq / type / payload / prev / hash`，
  `hash = sha256(canonical({seq,type,payload,prev}))` 构成哈希链，追加后 fsync。
- `snapshot.json`：`{lastSeq, headHash, state, stateHash}`，`stateHash` 为自校验哈希。
- `index.json`：物化视图缓存（恢复时以 WAL 为准重建）。

**故障点**（明确定义，可用 `EVIDENCE_FAULT_AT` 或 `Store.open(dir, {faultAt})` 注入）：

1. `after_append`：事件已追加并 fsync 到 WAL，内存索引尚未更新。
2. `before_index`：内存图已应用事件，持久化索引尚未写入。
3. `after_snapshot`：快照已写盘，WAL 尚未截断。

**恢复**：加载最近一致快照（校验 `stateHash`），重放 `seq > lastSeq` 的 WAL 记录并逐条
验证哈希链（`prev` 链接 + 事件哈希 + 与快照头的一致性）；重放按 `seq` 幂等，
快照后崩溃不会重复应用。链断裂 → `E_HASH`，记录损坏 → `E_WAL`。

## CLI

```
evidence add <fact.json>        # {"id":"f1","source":"s1","value":2,"data":{...}}
evidence derive <rule.json>     # {"id":"r1","op":"count|sum","premises":["f1"],"threshold":1}
evidence revoke <sourceId>
evidence restore <sourceId>
evidence remove <factId>        # 墓碑删除；restore 不会复活
evidence status <nodeId>        # 输出 {id, kind, state, support, ...}
evidence snapshot
evidence verifylog              # 校验快照完整性与 WAL 哈希链
```

错误以 JSON 输出到 stderr，退出码 1：`E_CYCLE`、`E_SOURCE_GONE`、`E_WAL`、`E_HASH`
（另有输入类 `E_INPUT` / `E_DUP`，故障注入 `E_CRASH`）。

## 测试

```
node --test
```

- `test/graph.test.js`：聚合、三值语义、循环检测、撤销/恢复。
- `test/persistence.test.js`：WAL/快照恢复、篡改检测、三故障点注入。
- `test/acceptance.test.js`：四条验收（三级派生撤销、恢复不复活已删事实、
  100 节点随机图与独立参考闭包枚举对照、三故障点恢复确定性）。
- `test/cli.test.js`：CLI 端到端。
