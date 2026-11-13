# 对象通知与清单对账

零依赖、可直接导入的 TypeScript 对账组件。它把至少一次（at-least-once）到达的对象通知与周期性 inventory 快照合并成确定性的对象状态，并对二者不一致的地方生成带双份证据的修正事件。

设计目标是解决数据湖入口的四类常见问题：

- 同一通知重复投递；
- 通知早于对象可读；
- 通知晚于删除，或通知到达顺序与事件发生顺序相反；
- inventory 快照落后于通知，不能拿旧快照删除新对象。

## 快速开始

```ts
import { ObjectReconciler, reconcile } from "./index.ts";

const notifications = [
  {
    eventId: "evt-1",
    key: "lake/orders/dt=2026-11-14/part-0.parquet",
    operation: "create" as const,
    eventTime: 1_000,
    version: "etag-1",
  },
];

const snapshots = [
  {
    snapshotId: "inventory-2026-11-14T01",
    boundary: 2_000,
    objects: [{ key: "lake/orders/dt=2026-11-14/part-0.parquet" }],
  },
];

// 无状态入口
const result = reconcile(notifications, snapshots);
console.log(result.objects, result.corrections, result.pending);

// 有状态入口：适合在消费者里持续 ingest
const reconciler = new ObjectReconciler();
reconciler.ingestNotifications(notifications);
reconciler.ingestSnapshots(snapshots);
const sameResult = reconciler.reconcile();
```

`index.ts` 同时导出 `ObjectReconciler`、`Reconciler` 别名、`createReconciler()`、`reconcile()` 及全部类型。

## 输入模型

### ObjectNotification

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `eventId` | 是 | 稳定的源事件 id，至少一次投递的重复副本必须复用同一个 id |
| `key` | 是 | 完整对象键，如 `bucket/prefix/object` |
| `operation` | 是 | `"create"` 或 `"delete"` |
| `eventTime` | 是 | 源事件发生时间，任意一致且可比较的数值（epoch ms、序列号等） |
| `version` | 否 | ETag / version，作为证据保留 |
| `readableAfter` | 否 | 对象最早可被读到的水印，默认等于 `eventTime` |
| `receivedAt` | 否 | 消费/入库时间，只作证据，绝不参与排序 |

排序依据是 `(eventTime, eventId)`，不是 `receivedAt`。因此“晚到的旧事件”会回到它在历史上的正确位置，不会覆盖更晚的删除。

### InventorySnapshot

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `snapshotId` | 是 | 稳定快照 id，用于去重和证据引用 |
| `boundary` | 是 | 快照覆盖边界：覆盖 `eventTime <= boundary` 的通知 |
| `objects` | 是 | 完整清单；元素可为对象或字符串键 |
| `capturedAt` | 否 | 采集时间，只作证据 |

`objects` 必须是该边界上的**完整**清单，而不是增量列表。默认边界为闭区间；如果 inventory 采集点严格排除边界瞬间的事件，可设置：

```ts
const reconciler = new ObjectReconciler({ boundaryInclusive: false });
```

## 对账语义

1. **事实幂等**：通知按 `eventId` 去重，快照按 `snapshotId` 去重。完全相同的重复投递返回 `false`，状态不变。
2. **全序重放**：每次 `reconcile()` 都把通知按 `(eventTime, eventId)`、快照按 `(boundary, snapshotId)` 重新排序后折叠，不依赖 ingest 顺序。
3. **边界覆盖**：只有 `eventTime <= boundary` 的通知才会参与该快照的期望状态计算。比快照新的通知留在待确认集合里，不会被旧清单误删。
4. **待确认集合**：`result.pending` 按对象维护尚未被 inventory 覆盖的通知，原因包括：
   - `no-snapshot`：还没有任何快照；
   - `newer-than-snapshot`：通知晚于最后一个快照边界；
   - `awaiting-visibility`：通知已被边界覆盖，但 `readableAfter` 水印尚未到达，快照还不能对它下结论。
5. **删除闸门**：只有当对象由已覆盖的通知（或此前已确认的清单存在性）推出为 present、当前快照在边界内明确缺失、并且可见性水印已到达时，才生成 `delete` 修正。快照边界之前的事件、晚于边界的通知、尚未可读的对象都不会触发删除。
6. **清单反向修正**：清单列出但通知已删除时生成 `restore`；清单单独发现对象时生成 `create`（下游统一 `upsert`）。
7. **证据完整**：每个 `Correction` 都带 `evidence.notifications` 和 `evidence.snapshots`。如果对象最初只由清单发现，通知证据是空数组，组件不会伪造通知。

## 输出

```ts
interface ReconciliationResult {
  objects: ReconciledObject[];   // 所有观察到的键，含 exists=false 的墓碑
  corrections: Correction[];     // 仅真实不一致，按边界/键/类型排序
  pending: PendingObject[];      // 待确认集合，按键排序
}
```

修正事件示例：

```json
{
  "id": "correction:inv-2:delete:lake/a.parquet",
  "type": "delete",
  "reason": "missing-from-snapshot",
  "key": "lake/a.parquet",
  "at": 2000,
  "snapshotId": "inv-2",
  "expected": "present",
  "observed": "absent",
  "action": "delete",
  "evidence": {
    "notifications": [
      {
        "eventId": "evt-1",
        "key": "lake/a.parquet",
        "operation": "create",
        "eventTime": 1000
      }
    ],
    "snapshots": [
      {
        "snapshotId": "inv-2",
        "boundary": 2000,
        "present": false
      }
    ]
  }
}
```

`Correction.id` 只由 `snapshotId + type + key` 决定，下游可直接用它做幂等键。`action` 为 `"delete"` 或 `"upsert"`，方便写回索引表。

## 确定性保证

只要事实集合相同，任意 ingest 顺序都会得到逐字节相同的 `JSON.stringify(result)`：

- 通知/快照按稳定键排序后折叠；
- 相同 `eventTime` 用 `eventId` 打破平局；
- 重复通知只保留最早 `receivedAt` 作为证据，不影响状态；
- 输出数组和证据数组都显式排序；
- 相同 id 但内容冲突的重复事实会抛 `ReconciliationInputError`，而不是“最后写入者获胜”。

## 其他 API

```ts
reconciler.ingestNotification(n); // 返回 true=新增，false=幂等重复
reconciler.ingestSnapshot(s);
reconciler.ingestNotifications(ns);
reconciler.ingestSnapshots(ss);
reconciler.addNotification(n);    // 别名
reconciler.recordSnapshot(s);     // 别名
reconciler.getPending();
reconciler.getCorrections();
reconciler.getObjects();
reconciler.clear();
```

## 测试

```bash
npm test       # 编译到 .test-build 后运行 node:test
npm run typecheck
```

测试覆盖：边界内缺失删除、旧快照不删除、未来通知保持 pending、`readableAfter` 可见性、重复通知/快照、晚到与乱序重放、删除后清单恢复、纯清单对象、版本透传，以及 120 种混合事实全排列的一致性。
