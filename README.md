# 对象通知与清单对账

对象存储采集服务需要可导入的 TypeScript 通知对账库，融合可能重复乱序的 create/delete 事件与周期 list 清单。版本化桶按 version id 裁决，无版本桶用观测世代避免迟到删除误伤重建对象。输出缺失、幽灵和待确认集合，连续两轮一致才收敛。

## 用法

```ts
import { Reconciler } from "dlks-de-0236";

const reconciler = new Reconciler({ versioned: true }); // 无版本桶省略选项

// 事件可重复、可乱序；携带 eventTime 时按源侧时间裁决
reconciler.ingestEvent({ type: "create", key: "a", versionId: "v1", eventTime: 100 });
reconciler.ingestEvents(streamOfEvents);

// 每轮周期清单产出一次报告
const report = reconciler.ingestList(listedObjects, snapshotTime);
// report.missing  —— 事件期望存在但清单缺失（连续两轮确认）
// report.ghost    —— 清单存在但事件期望不存在（连续两轮确认）
// report.pending  —— 本轮新出现、待下一轮确认的差异
// report.converged —— 本轮差异集合与上一轮完全一致
```

## 语义

- **去重**：事件按 `(type, key, versionId, eventTime)` 指纹去重，重复投递安全。
- **版本化桶**：create/delete 只作用于完全相同的 `(key, versionId)`；乱序到达时以 `eventTime` 裁决，旧事件被丢弃。
- **无版本桶**：删除后再次观测到存在（create 事件或清单观测）会推进**观测世代**；针对旧世代的迟到删除不改变状态。`ingestList` 传入 `observedAt` 时，早于已应用事件的旧清单快照不会误触发生世推进。
- **收敛**：差异首轮进入 `pending`，次轮仍存在则晋升为 `missing`/`ghost`；两轮差异集合完全一致时 `converged = true`。

## 脚本

- `npm test`：编译到 `dist/` 并运行 `node --test`
- `npm run typecheck`：严格类型检查
- `npm run build`：产出 `dist/`（含声明文件）
