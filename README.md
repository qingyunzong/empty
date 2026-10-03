# coldstore-agv-scheduler

冷库 AGV 离线调度器：单机、离线、仅 Node.js 22 标准库。读取地图、任务流与授权流，
按安全策略判定任务能否进入禁区（restricted）/ 冷链区（coldchain）/ 充电区（charging），
并输出可审计的 plan / deny 记录。

## 运行

```bash
node cli.js --map map.json --tasks tasks.jsonl --grants grants.jsonl \
  --plan plan.jsonl --deny deny.jsonl
node --test   # 全部测试
```

示例数据见 `examples/`。

## 输入格式

### map.json
`{ "width": W, "height": H, "zones": [{ "id", "kind": normal|restricted|coldchain|charging,
"aisles": [{ "id", "shelves": [{ "id", "x", "y }] }] }] }`

### tasks.jsonl（每行一个任务）
```json
{
  "id": "T1",
  "kind": "normal | rescue",
  "priority": 10,
  "subject": "agv-1",
  "target": { "zone": "Z-RES", "aisle": "A-1", "shelf": "S-10", "x": 10, "y": 10 },
  "occupyUntil": 600,
  "dualAuth": ["alice", "bob"],
  "dispatch": { "event": "d1", "lamport": 7, "parents": ["e3"], "time": 120 }
}
```

### grants.jsonl（每行一条授权或撤销）
```json
{ "id": "g1", "op": "grant",  "subject": "*", "level": "zone|aisle|shelf",
  "zone": "Z-COLD", "aisle": "A-2", "shelf": "S-20",
  "event": "e1", "lamport": 1, "parents": [], "time": 0, "from": 0, "to": 1000 }
{ "id": "r1", "op": "revoke", "subject": "*", "level": "zone", "zone": "Z-COLD",
  "event": "e2", "lamport": 2, "parents": ["e1"], "time": 500 }
```

## 核心机制

- **权限继承**：授权可挂在 库区(zone) → 巷道(aisle) → 货架(shelf) 任一层级，向下继承；
  plan 记录 `permission.path` 标明继承链与授权挂载层级。
- **撤销分段**：grant 有生效窗口 `[from, to)`；revoke 在其 `time` 处截断匹配
  （同 subject + 同层级 + 同范围）的授权。撤销前已占用巷道的任务保留临时通行证
  （`tempPass.until = occupyUntil`）直至完成；撤销生效后的新任务不得沿用，直接 deny。
- **生命救援破例**：`kind: "rescue"` 且目标为禁区时，无有效授权也可放行，但必须提供
  恰好两名不同授权人 `dualAuth`；plan 记录 `exception` 审计字段（类型、授权人、被覆盖的
  拒绝原因）。普通高优先级任务不可破例。
- **Lamport 因果**：所有授权/撤销/派单都是带 `lamport` 与 `parents` 的事件。
  “先见授权后派单”：授权事件必须位于派单事件的因果过去（parents 可达），否则以
  `grant-not-visible` 拒绝；plan 记录 `causalChain`（授权事件 → 派单事件的因果链）。
- **反例生成**：每条 deny 记录附带 `counterexamples`——逐一删除每条撤销后重新判定，
  若任务变为合法，则记录该撤销 id、恢复生效的授权与证据文本。

## 输出

- `plan.jsonl`：`{ task, decision: "allow", zone, zoneKind, permission, causalChain,
  tempPass?, exception? }`
- `deny.jsonl`：`{ task, decision: "deny", zone, reason, detail, counterexamples }`

`reason` 取值：`no-grant-for-target` / `grant-not-visible` /
`grant-expired-or-revoked`（可附加 `+rescue-dual-auth-missing`）。

## 错误码

| exit | 含义 |
|------|------|
| 22   | 时钟缺父事件 / Lamport 时钟违规（不大于父事件）/ 事件 id 重复 |
| 23   | 坐标越界（地图货架或任务目标超出 width×height） |
| 24   | 双人授权为同一人 |
| 2    | 其他输入格式错误 |

## 库 API

- `src/map.js`：`loadMap` / `indexMap` / `resolveTarget`
- `src/events.js`：`normalizeEvents` / `buildEventIndex`（`isCausallyBefore`、`causalPath`）
- `src/policy.js`：`evaluateTask` / `findCounterexamples` / `enumerateReachableZones`
- `src/scheduler.js`：`schedule(mapIndex, grants, tasks) -> { plan, deny }`
