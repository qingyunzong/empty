# config-migrate

桌面程序配置迁移库（TypeScript + Node.js 内置库，零运行时依赖）。

## 功能

- **版本图选路**：迁移注册为有向边（`from` 版本 → `to` 版本），`findPath` 以
  （步数, 迁移 ID 序列）字典序取最优——**优先步数少，并列时按迁移 ID 序列字典序最小**。
- **可逆补丁**：每个迁移携带 `up` / `down` 一对补丁。
- **失败反序回滚**：某步 `up` 失败时，已应用的步骤按**反序**用 `down` 恢复。
- **回滚失败保留续恢复位置**：`down` 失败时，日志（journal）停留在失败步骤的
  `rollbackIndex`，之后的 `recover()` 从该位置继续。
- **断电恢复**：崩溃后由 `recover()` 依据**落盘的配置版本**重算回滚位置，
  与丢失的是哪一次写入无关；重复调用 `recover()` 幂等。
- **内存文件适配器**：`InMemoryFileAdapter` 支持故障注入
  （`cutPowerAfter(n)` 模拟断电），用于核对分支路径、断电与重复恢复。

## 结构

```
src/types.ts          配置、迁移、文件适配器、日志类型
src/graph.ts          VersionGraph：版本图与最优路径选择
src/migrator.ts       Migrator：前向迁移、反序回滚、日志、recover()
src/memory-adapter.ts InMemoryFileAdapter：内存存储 + 断电故障注入
scripts/build.mjs     零依赖构建：擦除 TS 类型到 dist/，并 import 校验
tests/                node:test 用例（分支路径 / 回滚续恢复 / 断电重复恢复）
```

## 用法

```ts
import { VersionGraph, Migrator, InMemoryFileAdapter } from './src/index.js';

const graph = new VersionGraph();
graph.add({
  id: 'm1', from: '1.0', to: '2.0',
  up:   (c) => ({ ...c, settings: { ...c.settings, theme: 'dark' } }),
  down: (c) => { const s = { ...c.settings }; delete s.theme; return { ...c, settings: s }; },
});

const adapter = new InMemoryFileAdapter();
adapter.write('config.json', JSON.stringify({ version: '1.0', settings: {} }));

const migrator = new Migrator(graph, adapter);
migrator.migrate('2.0');   // 应用路径上的全部 up 补丁
migrator.recover();        // 崩溃/回滚失败后调用；无日志时为幂等空操作
```

## 恢复语义

- 迁移中每步：写配置 → 写日志（`applied` 递增）。
- `up` 失败：日志置为 `rolling-back`，按反序执行 `down` 后抛出 `MigrationError`。
- `down` 失败：日志保留在失败步骤（`rollbackIndex` 不变），抛出
  `MigrationError`（`phase: 'rollback'`），之后 `recover()` 从该位置续恢复。
- 适配器写入失败（断电）：异常直接传播；`recover()` 依据落盘的
  `config.version` 重算还需回滚到哪一步，因此任意一次写入丢失都可正确恢复。
- 存在未完成日志时 `migrate()` 拒绝执行，须先 `recover()`。

## 测试

```
npm test
```

`npm test` 先执行 `node scripts/build.mjs`（把 `src/`、`tests/` 的 TS 擦除类型
输出到 `dist/`，并对库模块做 import 校验），再用 `node --test` 运行全部用例。

### 实际结果（Node v22.22.1，2026-10-05）

```
compiled dist/src/graph.js
compiled dist/src/index.js
compiled dist/src/memory-adapter.js
compiled dist/src/migrator.js
compiled dist/src/types.js
compiled dist/tests/graph.test.js
compiled dist/tests/migrator.test.js
compiled dist/tests/recovery.test.js
build ok
# tests 3        # 3 个测试文件
# pass 3
# fail 0
```

逐用例（共 17 个，全部通过）：

```
graph.test.js
  ok 1 - prefers the path with fewest steps on a branching graph
  ok 2 - fewer steps wins even against lexicographically smaller ids
  ok 3 - breaks step-count ties by migration id sequence
  ok 4 - tie-break compares the whole id sequence, not just the first id
  ok 5 - returns null for unreachable targets and terminates on cycles
  ok 6 - same source and target yields an empty path
  ok 7 - multi-hop route through an intermediate branch
migrator.test.js
  ok 1 - migrates across the full path and cleans up the journal
  ok 2 - failed step rolls back applied steps in reverse order
  ok 3 - rollback failure keeps the resume position in the journal
  ok 4 - migrate refuses to run while a journal is pending
  ok 5 - unknown target and same-version requests
recovery.test.js
  ok 1 - power loss mid-migration: recover() restores the original config
  ok 2 - power loss during rollback: recover() resumes from the journaled position
  ok 3 - repeated recovery is idempotent
  ok 4 - recover() with no journal is a no-op
  ok 5 - power loss again during recovery: retry completes later
```

## 备注

本环境 Node 未编译 TypeScript 支持且无网络安装 `tsc`，故 `scripts/build.mjs`
实现了一个受限 TS 子集的类型擦除器（支持 interface/type/注解/声明泛型/
`import type` 等；不支持 enum、`as`、三元 `? :` 等，遇到会直接报错）。
源码即标准 TS，`tsconfig.json` 供编辑器与有 `tsc` 的环境做类型检查。
