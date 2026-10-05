# xfer-sim

传输模拟库：分块传输 + 权限门控提交，所有决策落在确定性的 (tick, seq) 事件序上，
每个决议都产出证据，并可与独立的参考事件模型对账。

纯 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 核心规则

- **每批绑定权限版本**：`submitBatch` 缓存块时记录当前权限账本版本
  （`boundVersion`）。任何 grant/revoke 事件都会推进账本版本。
- **续传前重核权限**：`resume` 重新校验权限；被撤销期间拒绝续传并保持 paused；
  恢复时若版本漂移，证据中标注，暂停前缓存的批次随之失效。
- **撤销后不能提交已缓存块**：`commitBatch` 要求权限当前有效
  （否则 `PERMISSION_REVOKED`）且 `boundVersion` 等于当前版本
  （否则 `STALE_VERSION`，覆盖"撤销→再授权"场景，需重新提交批次）。
- **已发布对象保留历史**：`publish` 追加不可变版本；撤销权限只拒绝后续发布，
  不删除历史。
- **同 tick 按事件序**：事件按 `(tick, seq)` 全序处理；同 tick 内 revoke 与
  commit 的先后由 seq 决定。引擎拒绝乱序 dispatch。
- **决议证据**：每个事件产生一条 `Evidence`（decision、rule、
  permissionVersion、boundVersion、detail）。
- **与事件模型核对**：`src/model.ts` 是与引擎零代码共享的参考折叠实现；
  `reconcile()` 比对逐事件决议、最终块集合与发布历史。

## 结构

- `src/events.ts` — 事件类型与 (tick, seq) 全序
- `src/engine.ts` — `TransferEngine` / `PermissionLedger`，决策与证据
- `src/evidence.ts` — 证据记录与格式化
- `src/model.ts` — 参考事件模型（独立实现）
- `src/reconcile.ts` — 引擎 vs 模型对账
- `tests/engine.test.ts` — 规则单测（11 个用例）
- `tests/reconcile.test.ts` — 脚本化场景 + 25 个种子 × 240 事件的 fuzz 对账

## 测试

```sh
npm test   # tsc 类型检查并编译到 dist/，然后 node --test
```

注：本机 Node v22.22.1 未内置 type-stripping（`process.features.typescript === false`），
因此测试跑在 `tsc` 编译产物上；`tsc` 同时承担类型检查。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
> tsc && node --test dist/tests/*.test.js

# Subtest: dist/tests/engine.test.js
ok 1 - dist/tests/engine.test.js
# Subtest: dist/tests/reconcile.test.js
ok 2 - dist/tests/reconcile.test.js
1..2
# tests 2
# pass 2
# fail 0
# duration_ms ~667
```

两个测试文件共 15 个用例（`node:test` 顶层按文件计数为 2），全部通过；
25 个 fuzz 种子的引擎/模型对账均无 mismatch。
