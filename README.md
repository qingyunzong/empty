# exact-pivot

多层行列键透视库：精确整数（BigInt）汇总、NULL 独立分类、小计不重复计算叶数据、
带事件 ID 的幂等更正，输出树状行列与总计，并可与全表分组核对（空组、跨组迁移）。
仅使用 Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 使用

```ts
import { PivotTable, renderPivot } from './src/pivot.js';

const t = new PivotTable();
t.apply({ eventId: 'e1', rowPath: ['华东', '上海'], colPath: ['2025', 'Q1'], delta: 100n });
t.apply({ eventId: 'e2', rowPath: ['华东', null], colPath: ['2025', 'Q1'], delta: 30n });
// 更正：同一 eventId 幂等；correctionOf 串起更正链
t.apply({ eventId: 'e3', rowPath: ['华东', '上海'], colPath: ['2025', 'Q1'], delta: -100n, correctionOf: 'e1' });

const out = t.build();          // { rows, columns, cells, grandTotal }
console.log(renderPivot(out));  // 树状行列 + 总计
const report = t.reconcile();   // 与全表分组核对：mismatches / emptyGroups / migrations
```

## 规则

- **精确整数**：`delta` 接受 `bigint | number | string`，内部一律 BigInt 累加；非整数抛错。
- **NULL 独立分类**：路径中的 `null` 是独立的 NULL 类别，与字符串 `"null"` 互不混淆。
- **小计不重复计算**：每个节点 `subtotal = direct + Σ children.subtotal`，每片叶恰好计入一次。
- **更正幂等**：同一 `eventId` 重复 `apply` 返回 `'duplicate'`，不影响结果。
- **空组**：净额为 0 的组不进入树，由 `reconcile()` 的 `emptyGroups` 列出并核对。
- **跨组迁移**：`correctionOf` 更正链触及多个组时列入 `migrations`，总计守恒可核对。

## 测试

```sh
npm test   # tsc 编译 + node --test
```

实际结果见 [RESULTS.md](RESULTS.md)。
