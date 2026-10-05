# config-merge

分层配置合并库（TypeScript，零运行时依赖，仅使用 Node.js 内置模块）。

## 合并规则

按层从低到高合并，高层优先：

1. **对象递归合并**：两边都是普通对象时，按键递归合并。
2. **数组按稳定 ID 合并**：元素是含 `id` 键（可用 `idKey` 选项更换）的对象时，
   按 id 匹配并递归合并；新 id 追加在末尾；祖先层已知 id 保持原位。
   无 id 元素没有稳定身份，**整组由最高参与层替换**（若高层数组含无 id 元素）。
   同一层内重复 id：后者整体替换前者。数组中的删除标记必须带 id，否则忽略。
3. **显式删除**：`{ $delete: true }`（或用 `del()` 辅助函数）生成**墓碑**。
   删除不存在的项同样保留墓碑，用于遮蔽祖先层——因此可以先合并高层、
   再与祖先层合并（结合律），删除语义依然正确。
4. **类型变化整项替换**：高层与低层类型不同（如 string → object、object → 数组），
   低层子树整体丢弃，由高层整项替换。删除后由更高层重新引入时，祖先内容同样不参与合并。
5. **标量覆盖**：高层标量替换低层标量。

### 结合律

内部节点携带墓碑（tombstone）与遮蔽盾（shield），保证：

```
merge(merge(L1, L2), L3) ≡ merge(L1, merge(L2, L3)) ≡ 直接规则求值(L1, L2, L3)
```

`src/direct.ts` 是独立实现的"直接规则求值"器（对每个路径按规则直接取最终结果），
与 `src/merge.ts` 的顺序合并互为对照；随机化测试（300 轮）验证三者一致。

## API

```ts
import { mergeLayers, del } from "./src/merge";
import { resolveDirect } from "./src/direct";

const { value, provenance } = mergeLayers([
  { name: "base",  config: { a: 1, p: [{ id: "x", n: 1 }] } },
  { name: "env",   config: { a: 2, p: [{ id: "x", ...del() }] } },
]);
// value      = { a: 2, p: [] }
// provenance = [ { path: "a", source: "env", kind: "value" },
//                { path: "p[id=x]", source: "env", kind: "delete" } ]
```

- `mergeLayers(layers, { idKey? })` → `{ value, provenance }`：顺序合并，逐项来源。
- `resolveDirect(layers, { idKey? })` → `{ value, provenance }`：直接规则求值，
  provenance 额外携带每项的 `rule` 规则解释。
- `del()` → `{ $delete: true }` 删除标记。

路径格式：对象键用 `.` 连接；数组 keyed 元素为 `arr[id=x]`，无 id 元素为 `arr[#0]`。

## 运行

```bash
npm test    # 编译 + node:test 测试（tsc 需可用，本仓库无第三方依赖）
npm run demo  # 三层合并演示：逐项来源、规则解释对照、结合律与墓碑验证
```

## 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：10 项测试全部通过。

```
ok 1 - 对象按键递归合并，标量由高层覆盖
ok 2 - 数组按稳定 id 合并：同 id 递归合并、新 id 追加、顺序保持
ok 3 - 显式删除：对象键与数组元素（按 id）
ok 4 - 删除不存在的项也保留墓碑，遮蔽祖先层
ok 5 - 类型变化整项替换
ok 6 - 删除后由更高层重新引入（祖先被遮蔽，不参与合并）
ok 7 - 无稳定 id 的数组元素整组由高层替换
ok 8 - 单层恒等（无删除标记时）
ok 9 - 示例三层：顺序合并 ≡ 直接规则求值（值与逐项来源均一致）
ok 10 - 随机三层：结合律成立且与直接规则求值一致（300 轮）
# tests 10
# pass 10
# fail 0
```

另以 2000 轮随机三层用例做强化验证：左折叠 ≡ 右折叠 ≡ 直接求值，全部一致。

`npm run demo`（节选，完整输出见命令）：

```
=== 3. 一致性结论 ===
合并结果值一致：✓
逐项来源一致：✓

=== 4. 结合律与墓碑演示 ===
中间合并 L2+L3（此时 phantom 在两层中均不存在为实体）：
  墓碑保留：✓ plugins[id=phantom]（来源 L2-env）
结合律 merge(merge(L1,L2),L3) ≡ merge(L1,merge(L2,L3))：✓
phantom 被墓碑遮蔽（未出现在最终结果）：✓
右折叠结果 ≡ 直接规则求值：✓
```

逐项来源与规则对照表（`npm run demo` 第 2 节）示例行：

```
路径                      │ 三层合并来源 │ 直接规则来源 │ 规则解释
server.port               │ L2-env ✓    │ L2-env       │ 标量覆盖：高层值替换低层值
server.tls                │ L3-local ✓  │ L3-local     │ 显式删除：$delete 生成墓碑，遮蔽所有祖先层
plugins[id=phantom]       │ L2-env ✓    │ L2-env       │ 显式删除：…（即使删除时该项不存在，墓碑也保留）
features[#0]              │ L3-local ✓  │ L3-local     │ 无稳定 id 元素：整组取自最高参与层（L3-local）
mode                      │ —           │ —            │ 类型变化整项替换（string → object）；对象递归合并
```

## 文件结构

- `src/merge.ts` — 顺序合并核心：内部节点（含墓碑/遮蔽盾）、物化、逐项来源。
- `src/direct.ts` — 直接规则求值（独立实现，用于对照）+ 规则解释。
- `src/example.ts` — 示例三层配置。
- `src/demo.ts` — 演示：合并结果、逐项来源对照表、结合律与墓碑验证。
- `test/merge.test.ts` — 10 项测试（含 300 轮随机化结合律/一致性验证）。
