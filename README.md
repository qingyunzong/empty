# transfer-sim

传输模拟库：批次绑定权限版本、续传前重核权限、撤销后拒绝提交已缓存块、已发布对象保留历史。
同 tick 的权限变更与提交按事件序（seq）决议，每个决议产出证据并可与事件模型核对。

仅使用 TypeScript + Node.js 内置库（`node:test` / `node:assert`），无运行时依赖。

## 模型

- **事件日志**（`src/events.ts`）：一切状态变更都是事件，携带全局单调 `seq` 与逻辑 `tick`。
  同一 tick 内可以有多个事件，先后由 `seq` 决定。
- **权限账本**（`src/permissions.ts`）：`grant` / `revoke` 各自推进全局权限版本号。
  `resolvePermission(events, subject, resource, beforeSeq)` 是纯函数：重放 `seq < beforeSeq`
  的权限事件得到某时刻的有效权限。
- **传输引擎**（`src/engine.ts`）：
  - `openBatch`：批次绑定开批时的权限版本（`boundPermissionVersion`），无有效授权则拒绝开批。
  - `cacheBlock`：块仅缓存在批次内，尚未提交。
  - `suspend` / `resume`：续传前重核权限——当前有效权限为 deny 时拒绝续传，批次保持挂起。
  - `commit`：提交决议点。按当前事件序重放权限：allow 则把缓存块发布为对象新版本；
    deny（已撤销）则拒绝提交并丢弃已缓存块，批次进入 `aborted`，之后不能再缓存或提交。
- **已发布对象**（`src/publish.ts`）：`PublishedStore` 只追加版本快照，撤销权限不会删除历史。
- **决议证据**（`src/evidence.ts`）：每次 open / resume / commit 都产出 `ResolutionEvidence`
  （决议、理由、绑定版本、有效权限及其来源事件、所查阅的事件 seq 列表）。
  `checkEvidenceAgainstEventModel(events, evidence)` 以纯函数重放事件日志，独立重算
  有效权限与应有决议，逐项比对证据；被篡改或属于其他日志的证据会被判出不一致。

## 同 tick 决议规则

权限与提交落在同一 tick 时，不看 tick 大小，只看事件序：权限事件的 `seq` 小于提交事件的
`seq` 则对提交生效，反之不生效。测试还覆盖了“提交的 tick 更小但 seq 更大”的情形，
证明决议依据是事件序而非 tick 值。

## 使用

```ts
import { EventLog, PermissionLedger, PublishedStore, TransferEngine } from 'transfer-sim';

const log = new EventLog();
const ledger = new PermissionLedger(log);
const store = new PublishedStore();
const engine = new TransferEngine(log, ledger, store);

ledger.grant(1, 'alice', 'dataset');
engine.openBatch(2, 'batch-1', 'alice', 'dataset');   // 绑定权限版本 1
engine.cacheBlock('batch-1', { id: 'blk-1', data: '...' });
ledger.revoke(3, 'alice', 'dataset');
const evidence = engine.commit(4, 'batch-1', 'object-1'); // rejected，缓存块被丢弃
```

## 测试

```
npm test    # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

### 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - dist/test/evidence.test.js
ok 2 - dist/test/ordering.test.js
ok 3 - dist/test/transfer.test.js
# tests 3
# pass 3
# fail 0
```

逐文件明细（共 13 个用例，全部通过）：

```
dist/test/evidence.test.js   4/4 pass
  ok - every decision evidence checks out against the event model
  ok - evidence records bound version, effective permission and consulted events
  ok - tampered evidence is caught by the event model check
  ok - evidence referencing a foreign event log is caught
dist/test/ordering.test.js   3/3 pass
  ok - same tick: revoke sequenced before commit rejects the commit
  ok - same tick: commit sequenced before revoke is accepted
  ok - event sequence, not tick value, decides same-tick resolution
dist/test/transfer.test.js   6/6 pass
  ok - batch binds the permission version current at open time
  ok - open is rejected without an effective grant
  ok - commit publishes cached blocks and published object keeps full history
  ok - revocation before commit rejects the commit and discards cached blocks
  ok - resume re-verifies permission: revoked denies, re-grant allows again
  ok - published history survives revocation and later rejected commits
```
