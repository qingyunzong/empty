# finite-csp-solver

有限域约束求解库（TypeScript，仅依赖 Node.js 内置模块，零 npm 依赖）。

## 能力

- 至多 **16 个变量**（`MAX_VARIABLES`，超出即抛错），每个变量为整数有限域。
- 约束：**allDifferent**（单例传播）与**表约束**（允许元组列表，GAC 支持剪枝）。
- 传播到不动点后可回溯：所有域收缩都记录在 trail 上，撤销分支时按检查点恢复**全部域**。
- **节点预算**：每个分支点计 1 个搜索节点，预算耗尽即停。
- 三种结局输出：
  - `SAT` — 返回解（`findAll` 时返回全部解）；
  - `UNSAT` — 返回**完整无解树**（每个叶子 `failed`，内部节点 `exhausted`，内部节点数等于已计节点数）；
  - `CUTOFF` — 返回**未闭合前沿**（当前路径上各层未试过的候选值，树中对应 `open` 叶子）。
- **独立枚举核对**：`src/enumerator.ts` 不共享求解器任何传播/搜索代码，用笛卡尔积暴力枚举 + 直接约束判定交叉验证。

## 使用

```ts
import { solve } from './src/solver.js';

const result = solve(
  {
    domains: [[1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4]],
    constraints: [{ kind: 'allDifferent', variables: [0, 1, 2, 3] }],
  },
  { budget: 1000, findAll: true },
);
// result.status: 'SAT' | 'UNSAT' | 'CUTOFF'
// result.solutions / result.tree / result.frontier / result.nodes / result.maxDepth
```

独立核对：

```ts
import { checkAssignment, enumerateSolutions, isPartialConsistent } from './src/enumerator.js';
```

## 测试

```
npm test    # tsc 编译后运行 node --test
```

### 实际结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test` 退出码 0；测试文件直接运行的 TAP 明细：

```
ok 1 - allDifferent: SAT solution validated by independent enumerator
ok 2 - allDifferent: findAll solution count matches brute-force enumeration
ok 3 - allDifferent: UNSAT yields a complete, fully failed search tree
ok 4 - table constraint: SAT, counts and solutions cross-checked
ok 5 - table constraint: UNSAT when table forces equal values under allDifferent
ok 6 - node budget: CUTOFF reports an unclosed, consistent frontier
ok 7 - node budget: sufficient budget finds a solution within the limit
ok 8 - node budget: findAll under budget returns partial solutions with CUTOFF
ok 9 - undo: every branch rollback restores all domains exactly
ok 10 - solver rejects more than 16 variables and accepts exactly 16
ok 11 - invalid input is rejected
ok 12 - search is deterministic across runs
ok 13 - integration: 4-queens via allDifferent + diagonal tables, count = 2
# tests 13
# pass 13
# fail 0
```

## 结构

- `src/solver.ts` — 问题校验、传播（allDifferent 单例规则 + 表约束 GAC）、trail 撤销、DFS + MRV、节点预算、前沿/搜索树输出。
- `src/enumerator.ts` — 独立暴力枚举器与部分赋值一致性判定，用于交叉核对。
- `test/solver.test.ts` — 13 个用例：三种结局、撤销恢复、预算语义、16 变量上限、确定性、4 皇后集成（解数 = 2，与枚举一致）。
- `types/node-shims.d.ts` — `node:test` / `node:assert/strict` 的最小类型声明（无 @types/node 依赖）。
