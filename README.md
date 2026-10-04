# byte-range-sync

按原版本（base）字节区间合并两个分支补丁的同步库。TypeScript 编写，仅使用
Node.js 内置模块（`node:test` / `node:assert`），零运行时依赖。

## 合并规则

编辑 `Edit { start, end, text }` 表示把 base 的 `[start, end)` 替换为 `text`
（`start === end` 为插入，`text === ""` 为删除）。

- 两边完全相同的编辑：只应用一次；
- 区间不相交的编辑：全部应用，可合并；
- 同点插入：两个都保留，按分支 ID 字典序排列（小者在前），不算冲突；
- 区间重叠且内容不同：冲突；
- 删除与落在其区间内部的修改/插入：冲突（边界上的插入不冲突）。

同一侧内部重叠的编辑先由 `normalizeEdits` 合并为对 base 的不相交补丁。

## API（src/merge.ts）

- `merge(base, editsA, editsB, branchA = "a", branchB = "b"): MergeResult`
  - 成功：`{ ok: true, edits, text, map }`（合并后补丁、合并文本、位置映射）
  - 冲突：`{ ok: false, conflicts: [{ a, b }] }`
- `normalizeEdits(base, edits)` / `applyEdits(base, edits)`
- `PositionMap`：双向位置映射
  - `toMerged(offset)`：base 偏移 → 合并文本偏移；落在被替换/删除区间
    内部时返回 `null`；
  - `toOriginal(offset)`：合并文本偏移 → base 偏移；落在插入文本内部时
    返回 `null`；
  - 边界偏移映射到对应边界。两类固有的多对一：被删区间的两个端点塌陷
    为同一点（逆映射取区间起点）；插入点前后两个合并偏移对应同一 base
    偏移（正映射取插入文本之前的位置）。

## 测试与核对

```
npm test        # tsc 编译 + node --test
npm run typecheck
```

- 单元测试覆盖上述每条合并规则与映射行为；
- 短字符串全区间枚举核对（test/merge.test.ts）：
  - 枚举 `{a,b}` 上长度 ≤ 4 的全部 31 个 base、全部区间 × 4 种替换文本
    的全部单编辑对（73,008 对），与独立的顺序拼接 oracle 逐一对拍；
  - 枚举长度 ≤ 2 的 base 上全部双侧双编辑集合对（214,090 对）；
  - 对每个成功合并核对：交换两边结果一致、应用一致性、长度守恒、
    映射单调性、双向偏移回环（含上述两类固有例外的精确判定）、
    base 全部未触及区间在输出中内容不变、输出全部未触及区间来自
    base 相同内容。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
single-edit pairs: 73008 total, 45896 merged, 27112 conflicts
two-edit set pairs: 214090 total, 126166 merged, 87924 conflicts
# tests 15
# pass 15
# fail 0
```
