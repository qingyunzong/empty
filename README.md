# relation-store

版本化关系库：维护有向、带标签的边，支持版本差（diff）、逆差（inverse diff）
与原子批次提交。仅使用 TypeScript + Node.js 内置库，无运行时依赖。

## 语义

- **有向带标签边**：每条边为 `{ id, from, to, label }`，允许自环与任意循环。
- **同端点多 ID 不合并**：多条边可共享相同的 `(from, to)`，只要 `id` 不同即各自独立。
- **版本差**：`diff(from, to)` 输出三类变更——
  - `added`：目标版本存在而源版本不存在的边；
  - `removed`：源版本存在而目标版本不存在的边；
  - `relabeled`：同 `id`、同端点但标签变化的边（含旧/新标签）。
  - 同 `id` 但端点变化视为 `removed` + `added`，不算标签修改。
- **逆差验证**：`applyDelta(snapshot(to), invertDelta(diff(from, to)))` 必须还原
  源版本前像；`validateInverse(from, to)` 内置该校验。
- **批次原子**：`commit(batch)` 中任一操作非法（重复 id、删除/改标不存在的 id）
  则整批拒绝，不生成新版本，库状态不变。

## 使用

```ts
import { RelationStore } from './src/store.ts';

const store = new RelationStore();
const v1 = store.commit([
  { type: 'add', edge: { id: 'e1', from: 'a', to: 'b', label: 'knows' } },
  { type: 'add', edge: { id: 'e2', from: 'b', to: 'b', label: 'self' } }, // 自环允许
]);
const v2 = store.commit([
  { type: 'relabel', id: 'e1', label: 'follows' },
  { type: 'remove', id: 'e2' },
]);

store.diff(v1, v2);            // { added: [], removed: [e2], relabeled: [e1: knows→follows] }
store.validateInverse(v1, v2); // true
```

## 脚本

- `npm test`：先用 `tsc` 编译到 `dist/`，再以 `node --test` 运行全部测试。
- `npm run typecheck`：仅类型检查（`tsc --noEmit`）。

要求 Node.js >= 22.18 与可用的 `tsc`（开发依赖，全局安装即可）。
`types/node-shims.d.ts` 为 `node:test` / `node:assert/strict` 提供最小类型声明，
无需安装 `@types/node`。

## 测试

- `test/store.test.ts`：确定性单元测试——三类 diff 输出、同端点多 ID 不合并、
  自环/循环、批次原子性、端点变更的 remove+add 语义、逆差还原前像。
- `test/random.test.ts`：属性测试——30 组随机种子生成随机版本历史，
  对随机版本对将 `store.diff` 与独立的集合差参考模型逐一比对，
  并验证正向应用得到后像、逆差应用还原前像；另有 200 次随机非法批次
  验证原子性。

实际测试结果见 [RESULTS.md](./RESULTS.md)。
