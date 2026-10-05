# type-infer

一个纯 TypeScript / Node.js 内置库实现的类型推断核心库，零运行时依赖。

## 特性

- **类型项**：类型变量 `tvar(id)`、函数类型 `tfun(p, r)`、列表类型 `tlist(e)`（`src/types.ts`）。
- **统一 occurs 检查**：所有统一路径（增量缓存的 `ConstraintStore` 与从头重算的无缓存统一器 `unifyAll`）共享同一个 `occurs` 实现（`src/unify.ts`）。
- **命名约束可撤销**：`store.add(name, lhs, rhs)` 注册唯一命名的等式约束；`store.revoke(name)` 撤销并用无缓存统一器重算缓存。
- **最小 ID 序冲突链**：`add` 失败时返回 `conflict.constraints`——按约束 ID 升序、1-极小（移除其中任意一条即可解）的冲突链，且必然包含新约束本身。
- **旧类型快照不可改**：所有类型节点构造时深度冻结；`store.snapshot()` 返回冻结的 `SubstSnapshot`（内部私有副本），之后的 `add`/`revoke` 不影响旧快照，严格模式下任何写尝试都会抛 `TypeError`。
- **小项展开**：`expand(t, subst)` / `store.expand(t)` / `snap.expand(t)` 把类型完全展开为只含未绑定变量的冻结新项，幂等且必然终止（occurs 检查保证无环）。

## 用法

```ts
import { tvar, tfun, tlist, typeToString } from "./src/types.js";
import { ConstraintStore } from "./src/unify.js";

const store = new ConstraintStore();
store.add("c1", tvar(0), tlist(tvar(1)));        // { ok: true, id: 1 }
const r = store.add("c2", tvar(0), tfun(tvar(2), tvar(2)));
// r.ok === false，r.conflict.constraints 为 [c1, c2]（ID 升序、1-极小）
store.revoke("c1");                               // 撤销后
store.add("c2", tvar(0), tfun(tvar(2), tvar(2))); // 现在成功
typeToString(store.expand(tvar(0)));              // "(t2 -> t2)"
```

## 测试

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行（Node.js 内置测试运行器）
```

随机对照测试（`test/random.test.ts`）以确定性种子（mulberry32）生成随机约束批，把
增量缓存存储与无缓存统一器 `unifyAll` 的结果通过小项展开逐变量、逐约束边对照；
并随机撤销约束后再次对照。单测见 `test/unify.test.ts`。

## 实际测试结果

环境：Node.js v22.22.1，TypeScript（tsc）7.0.2，Linux x64。`npm test` 实际输出：

```
# Subtest: dist/test/random.test.js
ok 1 - dist/test/random.test.js
# Subtest: dist/test/unify.test.js
ok 2 - dist/test/unify.test.js
# tests 2
# pass 2
# fail 0
```

逐条子测试（15/15 通过）：

```
ok - cached store matches no-cache unifier on random constraints   (300 个种子)
ok - random revokes keep cached store in sync with no-cache oracle (300 个种子)
ok - small-term expansion is idempotent and snapshot-stable        (100 个种子)
ok - unify binds variables to functions and lists
ok - unified occurs check rejects cyclic bindings
ok - constructor mismatch between fun and list fails
ok - failed add leaves store unchanged and reports minimal ID-ordered chain
ok - conflict chain is 1-minimal and sorted by id
ok - named constraints are revocable and solvability is restored
ok - duplicate constraint names are rejected
ok - old snapshots are immutable and unaffected by later adds
ok - type constructors produce deeply frozen terms
ok - equalUnder compares fully expanded forms
ok - minimizeConflict throws on solvable input
ok - unifying a variable with itself (distinct nodes, same id) is a no-op
```

随机测试曾抓出并修复一个真实 bug：同 ID 但不同节点的类型变量统一时
被 occurs 检查误判为环（`t4 occurs in t4`），修复于 `unify` 的变量-变量分支。

## 目录结构

- `src/types.ts` — 冻结类型项、构造器、结构相等、打印、变量收集
- `src/unify.ts` — occurs 检查、统一、小项展开、无缓存统一器、冲突链最小化、快照、约束存储
- `src/node-shims.d.ts` — `node:test` / `node:assert` 的最小类型声明（环境无 @types/node）
- `test/gen.ts` — 确定性 PRNG 与随机类型/约束生成器
- `test/unify.test.ts` — 单元测试
- `test/random.test.ts` — 随机对照测试
