# sync-import

三方同步导入库（TypeScript，仅 Node.js 内置模块，零外部依赖）。

## 模型

一次同步涉及三份快照，每份快照是一组 `{ id, fields }` 条目：

- `base`：上次成功同步时留存的目标基线
- `source`：本次导入的源批次
- `target`：目标存储的当前状态

## 规则

1. **目标未改动**（`target` 与 `base` 深度相等）：整批直接应用，结果即 `source`，
   `batchStatus: "applied"`。
2. **目标有任何改动**：**全批冲突**，不做按项目的部分覆盖。
   `batchStatus: "conflict"`，`result: null`，报告逐项列出差异诊断。
3. **明确开启字段级三方合并**（`{ merge: true }`）：单侧改动的字段自动合并；
   双侧改不同的字段、以及删除-vs-修改的条目，必须通过 `directives` 显式裁决。
   全部裁决完成 → `batchStatus: "merged"`；否则仍为 `"conflict"` 且 `result: null`。

## API

```ts
import { syncBatch } from './src/sync.js';

const report = syncBatch(base, source, target, {
  merge: true,
  directives: {
    fields: { 'item-1': { color: { pick: 'source' } } },   // 或 { value: 'blue' }
    items: { 'item-2': 'target' },                          // 删除-vs-修改：保留哪侧
  },
});

report.batchStatus;      // 'applied' | 'conflict' | 'merged'
report.targetChanged;    // 目标是否偏离基线
report.items;            // 逐项决议：action + 字段级来源(source/target/both/resolved)
report.unresolved;       // 未解字段冲突（base/source/target 三值）
report.unresolvedItems;  // 未解条目冲突（delete-vs-modify）
report.result;           // 结果快照；批次未应用时为 null
```

## 测试

```
npm test    # tsc 编译后运行 node --test
```

测试包含单元用例与属性测试：属性测试用带种子的随机数生成器对基线施加
随机编辑（增删条目、增删改字段）得到 source/target，并与 `test/oracle.ts`
中**独立实现**的朴素规则引擎逐字段对照（批次状态、逐项动作、未解冲突、
结果快照）。

## 实际测试结果（2026-10-05，Node v22.22.1）

`npm test` 输出（退出码 0）：

```
> sync-import@0.1.0 test
> tsc && node --test dist/test/sync.test.js

TAP version 13
# Subtest: dist/test/sync.test.js
ok 1 - dist/test/sync.test.js
1..1
# tests 1
# pass 1
# fail 0
```

文件内 11 个用例明细（`node dist/test/sync.test.js`）：

```
ok 1 - untouched target: batch applies wholesale, result equals source
ok 2 - any target change conflicts the whole batch; nothing is applied
ok 3 - merge disabled: field conflicts are diagnosed but not resolved
ok 4 - explicit merge: non-conflicting field edits merge automatically
ok 5 - explicit merge: conflicting field needs a directive, then resolves
ok 6 - delete-vs-modify is an item-level conflict resolved only by directive
ok 7 - duplicate ids are rejected
ok 8 - property: untouched target always applies the source batch (500 trials)
ok 9 - property: random edits on both sides match the oracle (2000 trials)
ok 10 - property: directives resolving every conflict always merge (1000 trials)
ok 11 - property: no-merge mode never produces a result when target changed
# tests 11
# pass 11
# fail 0
```
