# 乳品工厂质量追溯（dairy-lineage）

回答："某原料批复检不合格时，哪些成品批、在途箱和客户工单受影响"，并支持化验员更正后撤销。
Node.js 22，仅标准库，测试用 `node:test`。

## 模型

- **节点 = lot**：`{id, kind(raw/wip/finished/order), qty, status}`。
- **边**：`{id, from, to, kind: consume|split|merge|rework, qty, ratio, time, prob}`；
  `prob` 为传播概率，默认等于 `ratio`（显式设置后独立）。
- **比例守恒**：任一 lot 的出边 `ratio` 之和 ≤ 1（split/merge/consume/rework 统一约束），
  违反报 `ERR_CONSERVATION`；成环边报 `ERR_CYCLE`，两者都在状态变更前抛出，不污染图。
- **传播语义**：`P(source)=1`，`P(v) = 1 - Π_{(u,v)} (1 - P(u)·p_uv)`，在可达子图上按拓扑序求值。
- **冻结规则**：`P(v) ≥ threshold` 且 `status ∈ {quarantine, in_stock, in_transit, delivered}`
  的下游批进入受影响集合；`delivered` 动作记为 `customer_notify`，其余为 `freeze`。
- **最小召回证书**：受影响集合恰好是谓词闭包——每个被列批次都单独满足规则
  （去掉它则集合不再完备），且无任何未列批次满足规则。`impact` 输出
  `certificate.{minimal, complete, evidence}` 逐批给出证据。

## 机制

- **增量重算**：`impact` 结果按 `(lot, threshold)` 缓存；`correct(edge)` 只失效
  该边源 lot 的祖先链上的缓存项（下游未变，查询结果不变），绝不全图失效。
- **undo/redo**：操作日志 + applied 指针；undo/redo 本身也写 WAL，跨重启可恢复。
- **WAL 段/索引协议**：提交 = ① 追加 segment + fsync → ② 原子替换 `index.json`
  （记录已提交 LSN）。故障点定义为①之后②之前：恢复时只重放 `lsn ≤ committed`
  的记录，并在打开时截断 segment 中未提交的尾部（防止 LSN 复用导致死记录复活），
  因此任意一批提交要么整体可见要么整体不可见。
- **snapshot**：原子写入全量状态（操作日志 + 指针），截断 WAL 并开启新 segment。

## CLI

```bash
node cli.js --data <dir> add-lot <id> --kind K --qty N --status S
node cli.js --data <dir> add-edge <id> <from> <to> --kind consume|split|merge|rework --qty N --ratio R --time T [--prob P]
node cli.js --data <dir> impact <lot> [--threshold 0.5]
node cli.js --data <dir> correct <edgeId> [--ratio R] [--qty N] [--prob P] [--time T]
node cli.js --data <dir> undo | redo | snapshot | dump
```

环边示例（退出码 1，状态不变）：

```
{"ok":false,"error":"ERR_CYCLE","message":"edge eX: FIN-301->RAW-042 closes a cycle"}
```

更正拆分比例（实测）：`correct e2 --ratio 0.5` 后
`FIN-301@0.6160, ORD-9001@0.6160, WIP-11@0.4000, WIP-12@0.5000`；
`undo` 后恢复 `FIN-301@0.5136, ORD-9001@0.5136, WIP-11@0.4000, WIP-12@0.3000`。

## 测试（`node --test` 真实输出）

```
TAP version 13
# Subtest: test/lineage.test.js
ok 1 - test/lineage.test.js
# Subtest: test/wal.test.js
ok 2 - test/wal.test.js
1..2
# tests 2
# pass 2
# fail 0
```

逐条验收（`node test/lineage.test.js` / `node test/wal.test.js` 真实输出）：

```
ok 1 - acceptance 1: 20-lot random DAG matches DFS reference for every source
ok 2 - acceptance 2: cycle edge reports ERR_CYCLE and leaves state untouched
ok 3 - acceptance 3: correcting split ratio recomputes incrementally, matches full recompute, undo restores
ok 1 - acceptance 4: kill -9 after segment write / before index write recovers deterministically
ok 2 - undo/redo pointer survives process restart via WAL
ok 3 - snapshot truncates WAL and recovery replays from snapshot base
```

验收对应：

1. **20 批随机图对照 DFS 参考**：3 个随机种子 × 20 个源批 × 3 档阈值，
   拓扑序递推与独立记忆化 DFS 参考逐批比对（容差 1e-9）。
2. **环边**：`ERR_CYCLE`（含自环），边数与 impact 结果前后一致；守恒违例同理。
3. **更正拆分比例**：缓存增量失效（断言仅失效 1 个祖先缓存项，无关子图命中缓存），
   结果与全量重算 `graph.impact` 深比较一致；undo 恢复原值、redo 恢复更正。
4. **kill -9**：子进程在故障点（segment 已写、index 未写）被 SIGKILL，
   重启后已提交批整体可见、未提交批整体不可见，连续 3 轮结果确定，
   且恢复后 undo/redo 与新提交均正常。

## 文件

- `src/lineage.js` — 谱系图、守恒/环校验、传播求值、最小召回证书
- `src/wal.js` — segment/index WAL、崩溃恢复、快照截断
- `src/store.js` — 操作日志、undo/redo、增量缓存失效
- `cli.js` — 命令行入口
- `fixtures/crash_child.js` — kill -9 故障点注入子进程
- `test/lineage.test.js` / `test/wal.test.js` — 验收测试
