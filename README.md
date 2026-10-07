# diff-alias-constraints

别名/差值约束库：记录形如 `x - y = d` 的约束（`d` 为 `bigint`），
支持差值查询、快照与回滚；矛盾约束被拒绝并返回证据路径。

## 用法

```ts
import { DiffConstraints } from "./src/diff-constraints.js";

const dc = new DiffConstraints();
dc.add("x", "y", 5n);            // { ok: true, redundant: false }
dc.add("y", "z", 3n);
dc.query("x", "z");              // { known: true, diff: 8n }
dc.query("x", "ghost");          // { known: false } —— 断开/未知变量

const snap = dc.snapshot();
dc.add("z", "w", 1n);
dc.rollback(snap);               // z-w 约束被撤销

const bad = dc.add("z", "x", 0n); // 与已有 x-z=8 矛盾
// bad.ok === false, bad.existing === -8n, bad.evidence 为 z~>x 的约束链
```

## 语义

- `add(x, y, d)`：记录 `x - y = d`。冗余约束返回 `{ ok: true, redundant: true }`；
  矛盾约束返回 `{ ok: false, existing, requested, evidence }`，**不修改任何状态**
  （包括不创建新变量）。`evidence` 是从 `x` 到 `y` 的约束链，各边差值之和即
  `existing`，与 `requested` 冲突；自约束 `x - x = d ≠ 0` 的证据为空链。
- `query(x, y)`：返回蕴含的 `x - y`；任一端未知或不连通时返回 `{ known: false }`。
- `snapshot()` / `rollback(snap)`：快照为不透明句柄，回滚撤销其后的全部操作
  （包括变量创建）。非法快照抛 `RangeError`。
- 所有差值均为 `bigint`，精度不受 `2^53` 限制。

## 实现

加权并查集（树边记录势能），按大小合并、不做路径压缩，配合显式撤销日志，
回滚即逆向回放日志。

## 测试

```sh
npm test        # tsc 编译 + node --test
npm run typecheck
```

随机测试以 BFS 势能遍历模型为参照，在多个种子下混合执行
add / snapshot / rollback / query，核验回滚后的差值与模型一致，
并校验每次拒绝的证据链确实被已接受约束集蕴含。
