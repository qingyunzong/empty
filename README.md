# 表单依赖字段事务填写

自动录入引擎需要可导入的 TypeScript 表单执行组件，根据字段依赖图填写联动下拉、异步校验和条件区域。每次输入等待与该字段世代匹配的稳定结果；上游变化撤销下游旧计划。循环依赖给出最小环，提交前生成可复核的最终字段快照。

## 使用

```ts
import { FormEngine } from "./index.ts";

const engine = new FormEngine({
  fields: [
    { name: "province" },
    {
      name: "city",
      dependsOn: ["province"],
      options: async (deps, ctx) => fetchCities(deps.province, ctx.signal),
    },
    {
      name: "taxId",
      dependsOn: ["applicantType"],
      visibleWhen: (deps) => deps.applicantType === "company",
      validate: async (value) => (value ? [] : ["必填"]),
    },
  ],
  sections: [
    { name: "companyInfo", fields: ["taxId"], visibleWhen: (v) => v.applicantType === "company" },
  ],
});

await engine.ready();
const field = await engine.setValue("province", "zhejiang"); // 等待世代匹配的稳定结果
const { ok, snapshot } = engine.submit(); // 提交前的可复核最终快照
```

## 语义

- **世代匹配**：每个字段持有单调递增的世代号；`setValue` 返回的 Promise 只在与本次输入世代匹配的稳定结果就绪后兑现为 `FieldSnapshot`，被更新输入取代时以 `StalePlanError` 拒绝。
- **撤销旧计划**：上游变化会递增下游全部字段的世代号并通过 `AbortSignal` 中止在途的 `options` / `compute` / `validate`，过期异步结果不会落地。
- **最小环**：构造时若依赖图存在循环，抛出 `DependencyCycleError`，其 `cycle` 为节点数最少的环（Tarjan 强连通分量 + 分量内 BFS 最短回路）。
- **提交快照**：`submit()` 在存在未稳定字段时抛出 `UnsettledFormError`；否则返回 `{ ok, snapshot }`，快照包含各字段值、选项、错误、可见性、世代号与条件区域状态。

## 脚本

- `npm run typecheck`：严格类型检查（`tsc --noEmit`）。
- `npm test`：先用 `tsc` 编译到 `build/`（`rewriteRelativeImportExtensions`），再以 `node --test` 运行测试。
