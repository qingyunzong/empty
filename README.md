# 主数据幸存者字段级归并

可导入的 TypeScript survivor 库。归并按**字段**独立进行：同一实体的不同字段可以来自不同记录；每个字段保留候选、评分、排除原因和最终决定规则，便于主数据服务审计。

## 快速使用

```ts
import { mergeEntity } from "dlks-de-0116";

const result = mergeEntity({
  entityId: "customer:42",
  records: [
    {
      recordId: "crm-9",
      sourceId: "crm",
      updatedAt: "2026-05-01T00:00:00.000Z",
      values: { name: "Ada Lovelace", email: "old@example.com" },
    },
    {
      recordId: "erp-3",
      sourceId: "erp",
      updatedAt: "2026-06-01T00:00:00.000Z",
      values: { email: "ada@example.com", phone: "+44 20 0000 0000" },
    },
  ],
  sourcePriorities: { crm: 100, erp: 80 },
  locks: [
    {
      field: "phone",
      recordId: "erp-3",
      lockedBy: "steward:alice",
      reason: "客户确认",
    },
  ],
  withdrawnSources: ["legacy"],
});

result.values.name;                    // "Ada Lovelace"
result.values.email;                   // "old@example.com"（来源优先级胜出）
result.fields.email.evidence.candidates; // 全部候选及证据
result.fields.phone.locked;            // true
```

也可以直接传入记录数组，或 `mergeEntity(entityId, records, options)`；`mergeSurvivor`、`mergeRecords` 是同一入口的别名。`selectField(field, records, options)` 暴露单字段归并逻辑。

## 规则

默认按以下顺序比较，**高优先级、较新、较完整**者胜出：

1. `sourcePriority`：来源优先级，数值越高越优先。解析顺序为字段级 `sourcePriorities` → `defaultFieldRule.sourcePriorities` → 全局 `sourcePriorities` → `record.sourcePriority` → 默认优先级 → `0`。
2. `freshness`：新鲜度，优先字段级 `fieldUpdatedAt[field]`，回退到记录级 `updatedAt`；较新者胜出。
3. `completeness`：完整性，默认按字段值的信息量评分（空值、空白、空数组/对象为 0）；可用字段级 `completeness(value, record, field)` 自定义，`recordCompleteness()` 提供记录填充率辅助函数。
4. `recordId`：**始终作为最后的稳定并列裁决**，按 UTF-16 码元升序比较，不受输入顺序和进程 locale 影响。

空值默认不参与排名，因此高优先级来源的空字段不会遮住低优先级来源的有效值；可用 `includeEmptyValues` 或字段级 `allowEmptyValues` 调整。`fieldRules[field].order` 可以调整准则顺序，未列出的准则按默认顺序补齐，但 `recordId` 始终固定在最后。

## 人工锁与来源撤回

- `locks` 支持数组和 `{ [field]: lock }` 两种形式；锁可以引用 `recordId`（读取该记录当前值）或直接给出 `value`。
- 人工锁优先于所有排名规则，`decidedBy` 为 `manual-lock`。库本身无状态，服务每次重算都应继续传入当前有效的人工锁。
- 调用方通过 `withdrawnSources`、`withdrawnRecordIds` 或记录的 `withdrawn: true` 触发重新计算。
- 撤回的来源/记录会从普通候选中排除并记录排除原因；其他字段正常重新归并。
- **人工锁不会因来源撤回而被覆盖**。若锁引用的是已撤回记录，值继续保留，证据中 `lock.preservedAfterWithdrawal` 为 `true`，并产生警告。若锁引用记录已完全不在输入中且没有显式 `value`，则保留锁意图并给出 `LOCK_RECORD_NOT_FOUND` 警告。

## 证据结构

每个 `result.fields[field]` 包含：

- `value`、`recordId`、`sourceId`、`hasValue`；
- `decidedBy`：`sourcePriority` / `freshness` / `completeness` / `recordId` / `manual-lock` / `only-candidate` / `no-candidate`；
- `evidence.candidates`：全部候选的 `sourcePriority`、`freshness`、`completeness`、`recordCompleteness`、`rank`、`eligible`、`excludedReasons`；
- `evidence.rankedWinner`、`selected`、`runnerUp`、`tieBreakUsed`、`ruleOrder`；
- `evidence.lock`：锁来源、锁定人、锁定时间、是否使用显式值、是否在撤回后保留。

顶层还返回 `fieldOrder`、`records`、`withdrawnSources`、`withdrawnRecordIds`、`lockedFields`、`warnings` 和 `recomputedAfterWithdrawal`，便于持久化审计快照。

## 开发

```bash
npm test
npm run typecheck
```
