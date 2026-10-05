# incremental-compile-cache

TypeScript 增量编译缓存库（仅依赖 Node.js 内置模块）。

## 设计

- **摘要分离**：每个模块的源码分为公开接口（`iface`）与实现（`impl`）两部分，
  分别哈希（`src/summaries.ts`）。
- **缓存键**（`src/compiler.ts` 的 `planComponents`）：
  - 自身部分 = 组件内每个成员的 `(name, ifaceHash, implHash)`；
  - 依赖部分 = 每条跨组件 import 边的 **被导入模块接口哈希**。
  - 推论：依赖方实现变更 → 键不变 → 缓存命中（仅重编自身）；
    接口变更 → 直接依赖方键变化 → 变化沿依赖传播。
- **循环模块**：Tarjan SCC 缩点（`src/graph.ts`），一个 SCC 是一个发布单元，
  整批编译、整批发布；组件间按依赖先序拓扑排列。
- **基线核验**（`src/baseline.ts`）：每次构建可生成 `Baseline`（模块摘要 +
  组件键/产物 + manifest 封印哈希）。恢复旧编译任务时 `resumeBaseline`
  校验 manifest 与产物存储的一致性，失效条目逐出缓存，下一次构建只重编
  被逐出的组件。
- **产物存储**（`src/store.ts`）：内存实现 + JSON 文件实现（供旧任务持久化恢复）。

## 测试

```
npm test    # tsc 编译 + node --test
```

- `test/compiler.test.ts`：接口不变仅重编自身、接口变化传播、SCC 整批发布、
  静默重建为零、基线核验/损坏修复、manifest 篡改拒绝（6 个用例）。
- `test/random.test.ts`：确定性 PRNG 随机图 + 随机编辑（改实现/改接口/增删边/
  增删模块），每步将增量编译结果与冷缓存全量编译模型逐一比对，并校验
  最小编译集与基线可恢复性。

## 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
# Subtest: dist/test/compiler.test.js
ok 1 - dist/test/compiler.test.js
# Subtest: dist/test/random.test.js
ok 2 - dist/test/random.test.js
# tests 2
# pass 2
# fail 0
random cross-check: 25 seeds x 30 edits, 261 impl-only checks, 155 iface-propagation checks
```
