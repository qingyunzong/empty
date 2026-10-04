# perm-merge

权限合并库（CRDT，remove-wins）：基于**因果版本（向量时钟）**的权限授予/撤销合并。
纯 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 语义

- 每个操作（`grant` / `revoke`）携带发起副本的**向量时钟**作为因果版本，绝不使用墙钟排序
  （`wallClockMs` 仅作为"不被使用"的证据保留，测试故意注入时钟偏移）。
- **并发撤销优先（remove-wins）**：同一权限的并发 `grant` 与 `revoke`，取 `revoke`。
- **因果后续授予可恢复**：若 `grant` 因果上严格晚于所有 `revoke`（即发起时已观察到撤销），
  该授予生效，权限恢复。
- 判定规则：授权 `g` 生效 ⟺ 不存在撤销 `r` 使得 `r` 与 `g` 并发或 `r` 晚于 `g`
  （即所有撤销都严格先于 `g`）。
- **乱序/重复/合并收敛**：操作可乱序、重复送达，或通过状态合并（`mergeFrom`）收敛，
  最终有效权限集相同。有效权限的**来源（source grants）按操作 ID 排序**，输出与送达顺序无关。

## 输出：有效权限及来源

`store.effective()` 返回 `Map<perm, { perm, sources }>`，每个来源包含
`opId`、发起者 `actor` 与因果版本 `clock`；`store.describe()` 给出规范文本形式：

```
doc:read <= A#2@{A:2,B:1}
```

运行 `npm run demo` 查看完整演示（并发撤销 → 恢复 → 收敛）。

## 模型核对

`src/model.ts` 是独立的参考模型（**偏序极大操作 + 撤销优先裁决**）：
对权限 P 的所有操作取因果偏序，授权 `g` 有效 ⟺ 没有任何 `revoke` 在偏序中覆盖它
（`r > g`）或与之不可比（`r ∥ g`）。`test/model.test.ts` 用确定性随机种子生成
数百个随机因果历史，以随机乱序 + 重复投递、以及随机分区后状态合并两种方式，
断言库实现与参考模型的有效权限集（含来源）完全一致。

## 使用

```bash
npm test   # 编译并运行全部测试
npm run demo
```

```ts
import { PermissionStore } from './src/index.js';

const a = new PermissionStore('A');
const b = new PermissionStore('B');
const g = a.grant('doc:read');
const r = b.revoke('doc:read'); // 并发 -> 撤销获胜
a.apply(r); b.apply(g);
a.isEffective('doc:read');      // false
const g2 = a.grant('doc:read'); // 因果晚于 r -> 恢复
b.apply(g2);
b.isEffective('doc:read');      // true
b.effective().get('doc:read')!.sources; // [{ opId: 'A#2', actor: 'A', clock: {A:2,B:1} }]
```

## 结构

- `src/vectorClock.ts` — 向量时钟：tick / join / 偏序比较
- `src/ops.ts` — 操作类型与 remove-wins 判定（`kills`）
- `src/store.ts` — `PermissionStore`：签发、乱序应用、状态合并、有效权限及来源
- `src/model.ts` — 偏序极大操作参考模型（规范）
- `test/semantics.test.ts` — 确定性语义测试（含墙钟偏移用例）
- `test/model.test.ts` — 随机乱序/合并 vs 参考模型核对
- `TEST-RESULTS.md` — 实际 `npm test` 输出记录
