# 在线离线特征对账

特征管线需要可导入的 TypeScript 对账组件，把离线表分区与在线 KV 快照按实体、特征定义版本和事件时间比较。采样由稳定 hash 决定，浮点使用字段容差；过期在线值与真实不一致分类不同。输出差异及两侧来源证据，不自动覆盖。

## 使用

```ts
import { reconcile, type FeatureDefinition } from "./index.ts";

const definitions: FeatureDefinition[] = [
  { name: "ctr", version: "v2", valueType: "float", tolerance: { abs: 1e-6, rel: 1e-4 } },
  { name: "click_cnt", version: "v3", valueType: "int", ttlMs: 3_600_000 },
];

const report = reconcile(offlineRows, onlineRecords, {
  definitions,
  sampleRate: 0.1, // 由稳定 hash 决定，可复现
  sampleSalt: "2026-11-13",
});

for (const diff of report.diffs) {
  // diff.kind: missing_online | unexpected_online | version_mismatch
  //            | stale_online | value_mismatch
  // diff.offlineEvidence / diff.onlineEvidence: 两侧来源证据
}
```

- 组件只读输入、只产出报告，不回写任何一侧。
- 在线记录事件时间落后于离线行，或超出特征 `ttlMs`，归为 `stale_online`，与真实取值不一致（`value_mismatch`）区分。
- 浮点比较按特征定义中的 `tolerance`：`|a-b| <= max(abs, rel * max(|a|, |b|))`。

## 脚本

- `npm run typecheck`：类型检查（`tsc --noEmit`）
- `npm run build`：编译到 `dist/`
- `npm test`：编译并运行 `node --test`
