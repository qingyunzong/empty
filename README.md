# 版本化时间旅行特征组件（可嵌入 TypeScript）

按版本与时间点提供在线点查，并保证与离线回填逐值一致的嵌入式特征组件，零运行时依赖。

## 目录

- `src/types.ts` — 事件、版本定义、三值结果（`present | default | missing`）与 `NO_DEFAULT` 哨兵
- `src/engine.ts` — 唯一评估入口 `evaluateFeature`，在线点查与离线回填共用
- `src/store.ts` — `FeatureStore`：暂存回填、原子发布、不可变版本句柄
- `src/offline.ts` — 离线全量回填 `backfillVersion` 与笛卡尔网格构造
- `src/errors.ts` — 领域错误（未发布/重复发布）
- `tests/feature-store.test.ts` — 样本序列穷举与交错测试

## 核心不变量

1. **在线/离线逐值相等**：两条路径都调用同一个 `evaluateFeature`，输入为同一份不可变版本快照；穷举网格中每个 `(实体, 版本, 时间点)` 的在线点查与离线全量结果 `deepEqual`。
2. **缺失与显式默认区分**：空窗口且无默认配置返回 `{status:"missing"}`（无 `value` 字段）；配置了默认（含 `0` 等假值）返回 `{status:"default", value}`；真实聚合出的 `0` 仍为 `present`。
3. **时间旅行**：按 `[t-window+1, t]` 闭区间取事件，二分定位下界；同刻事件保持到达顺序；查询时间落在版本 `[validFrom, validTo]` 之外一律 `missing`。
4. **版本切换只影响新请求**：`lookup` 在首个 `await` 前同步钉住版本句柄与事件切片，请求执行期间发布新版本不改变其结果。
5. **发布原子、无部分版本可读**：回填写入不可见的暂存草稿；`publish` 先完整构建并冻结快照，再以单次 `Map` 插入对外可见。暂存中（或未知）的版本统一抛 `VersionNotPublishedError`。

## 用法

```ts
import { FeatureStore, latestValue, NO_DEFAULT } from "./index.ts";

const store = new FeatureStore();
const staging = store.stageVersion({
  featureId: "billing.score", versionId: "v1",
  validFrom: 0, validTo: 100, window: 3,
  aggregate: latestValue, defaultValue: NO_DEFAULT,
});
staging.addEvents("entity-1", [{ entityId: "entity-1", eventTime: 10, value: 42 }]);
store.publish(staging);                 // 原子发布并置为活跃版本

const result = await store.lookup({ entityId: "entity-1", timestamp: 11 });
// { status: "present", value: 42, versionId: "v1", ... }
await store.lookup({ entityId: "entity-1", timestamp: 11 }, "v1"); // 显式版本
```

## 测试与构建

- `npm test` — 严格类型检查后编译并运行 node:test（6 个套件，覆盖穷举对照、三值区分、时间旅行边界、在途请求钉住、回填/发布交错、随机交错压力）
- `npm run build` — 输出带类型声明的 `dist/`
- `npm run typecheck` — 仅类型检查

说明：当前运行环境的 Node 未启用类型擦除，因此测试通过 `tsc` 编译到 `dist/` 后执行；`.ts` 扩展名导入在编译期由 `rewriteRelativeImportExtensions` 重写为 `.js`。
