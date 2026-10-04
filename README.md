# live-table-query

增量表查询库（TypeScript，仅 Node.js 内置模块，零依赖）。

## 功能

- **过滤 / 按键求和 / 排序前 k**：查询 = `filter(row)` 过滤 → 按 `key` 分组求和 `value` → 按和降序取前 `k`，**同分按键名升序**。
- **批更新只发布净差**：`applyBatch(ops)` 增量维护分组和，提交后只发布新旧 top-k 结果的净差（`Delta.changes`：新增 / 移除 / 值变），未变化的条目不出现。
- **订阅者读取固定版本**：每次提交版本号 +1；`pin(version)` 固定快照读取，引擎前进不影响；`release()` 后未固定的旧版本被回收。
- **查询代**：`setQuery(spec)` 更改条件或参数产生新 `generation`，并重算后发布旧→新净差；旧代快照仍可按版本读取。
- **每批全扫描核对**：每次批提交后与原始行全扫描结果比对（`reconcile()`），不一致抛 `ReconcileError`；可用 `{ verifyEachBatch: false }` 关闭。

## 结构

- `src/types.ts` — `Row` / `QuerySpec` / `Delta` 等类型
- `src/evaluate.ts` — 全扫描求值：分组求和、top-k、净差计算
- `src/live-query.ts` — `LiveQuery` 引擎（增量状态、版本快照、订阅、核对）
- `test/live-query.test.ts` — `node:test` 测试

## API 摘要

```ts
const q = new LiveQuery({ filter: (r) => r.attrs?.kind === "x", k: 3 });
const off = q.onDelta((d) => console.log(d.version, d.generation, d.changes));
const delta = q.applyBatch([
  { type: "upsert", row: { id: "1", key: "a", value: 5 } },
  { type: "delete", id: "2" },
]);
const sub = q.pin();        // 固定当前版本
sub.read();                 // 永远读到该版本快照
sub.release();
q.setQuery({ filter: () => true, k: 10 }); // 新查询代
q.read(); q.readAt(3); q.reconcile();
```

## 运行

```sh
npm test        # tsc 编译 + node --test
npm run typecheck
```

环境：Node.js v22.22.1，TypeScript 7.0.2（全局 tsc 编译到 `dist/` 后运行，无运行时依赖）。

## 实际测试结果（2026-10-05 记录）

`npm test` 输出：

```
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/live-query.test.js
ok 1 - dist/test/live-query.test.js
  ---
  duration_ms: 194.965368
  ...
1..1
# tests 1
# pass 1
# fail 0
# duration_ms 208.321023
```

直接运行测试文件可见全部 7 项子测试：

```
ok 1 - 过滤 + 按键求和 + 排序前 k，同分按键升序
ok 2 - 批更新只发布旧新结果净差
ok 3 - 删除行使分组和减少或消失
ok 4 - 订阅者读取固定版本，释放后旧版本被回收
ok 5 - 条件和参数更改产生新查询代，旧版本快照仍可读
ok 6 - 每批与全扫描核对：随机批次 + 影子结果重放净差
ok 7 - 边界：k=0、空表、负值、同分截断确定
# tests 7
# pass 7
# fail 0
```

其中第 6 项以固定种子随机生成 300 批 upsert/delete 与 17 次查询代切换，
引擎每批自动与全扫描核对（`reconcileChecks` 断言为 317 次），并用净差流
重放维护影子结果逐批比对一致。
