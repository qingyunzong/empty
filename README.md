# RPA 表格虚拟滚动稳定采集

浏览器 RPA 需要可导入的 TypeScript 虚拟表格采集协调器，以业务行键、视窗锚点和数据版本收集滚动加载结果。DOM 节点复用不能当作新行；排序或筛选世代变化时废弃未闭合轮次。完成条件由总数或连续稳定窗口证明，并返回缺口。

## 用法

```ts
import { createCollector } from "./index.js";

const collector = createCollector({ expectedTotal: 500, stableWindowsToComplete: 3 });

collector.beginRound("sort:asc|filter:none"); // 排序/筛选世代
collector.observe(
  {
    anchor: { firstKey: "row-0001", firstIndex: 0, scrollTop: 0 },
    rows: [{ key: "row-0001", version: "v3", index: 0, data: { /* ... */ } }],
  },
  "sort:asc|filter:none",
);
collector.closeRound();

const status = collector.status(); // complete / completionReason / gaps / collected
const { rows, gaps } = collector.result();
```

- 行以业务行键 `key` 去重；同键同版本的重复出现（DOM 复用、窗口重叠）不计为新行。
- `version` 变化视为行更新，重置连续稳定窗口计数。
- 世代（排序/筛选）变化时未闭合轮次被废弃，已闭合轮次保留。
- 完成条件：唯一行键数达到 `expectedTotal`，或连续 `stableWindowsToComplete` 个窗口无新行且无版本变化。
- `gaps` 按绝对行号 `index` 聚合缺失区间。

## 脚本

- `npm run typecheck`：类型检查
- `npm test`：编译并运行测试
