# authz-session-snapshot

鉴权会话库：**会话快照绑定策略版本**。长事务在其生命周期内按绑定快照继续读旧权限；
提交时必须用**最新策略版本**重核全部缓冲写动作，任一失败则**整体中止、一条都不落库**。

纯 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 设计

- `PolicyStore`（src/policy.ts）：每次 `grant`/`revoke` 产生不可变新版本，历史版本永久保留。
- `Session`（src/session.ts）：`openSession` 时绑定当前最新版本作为快照。
- `Transaction.read`：按会话绑定版本判定 —— 长事务可继续读旧权限。
- `Transaction.write`：按绑定版本乐观放行后进入缓冲，不落库。
- `Transaction.commit`：用 `policy.latestVersion` 重核**全部**缓冲写；
  任一被拒则返回 `aborted` 且 `DataStore` 无任何变更（失败全不提交）。
- `EvidenceLog`（src/evidence.ts）：每次判定记录 `{phase, checkedVersion, latestVersion, decision}`，
  可筛出旧快照命中（`staleHits`）与提交重核（`rechecks`）证据。

## 命令

```sh
npm test          # tsc 编译 + node --test 运行全部测试
npm run simulate  # 模拟策略撤销与提交交错，打印旧/新命中证据
```

## 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

### `npm test`

```
# Subtest: dist/test/authz.test.js
ok 1 - dist/test/authz.test.js
1..1
# tests 1
# pass 1
# fail 0
```

注：本机 Node 的 `--test` 对子进程按文件汇总；直接运行测试文件可见逐条结果：

```
$ node dist/test/authz.test.js
ok 1 - 快照绑定
ok 2 - 提交重核
ok 3 - 命中证据
ok 4 - 边界行为
# tests 10
# suites 4
# pass 10
# fail 0
```

### `npm run simulate`（撤销与提交交错）

时间线：v4 授权 alice 读写 doc/A、doc/B → 会话绑定 v4 开长事务 → 缓冲两条写 →
管理员撤销 doc/B 写权限（v4→v5）→ 长事务继续读 doc/B（旧快照放行）→ 提交按 v5 重核。

```
=== t7 提交：按最新版本重核全部缓冲写，失败则全不提交 ===
commit status = aborted (rechecked at v5)
  failure: doc/B - write permission revoked before commit (rechecked at v5)
store after abort = {} (应为空：一条都不落库)

=== t8 重开会话（绑定 v5），只写 doc/A，提交成功 ===
commit status = committed (rechecked at v5)
store = {"doc/A":"A-committed-under-v5"}
```

旧/新命中证据：

```
# 5 read           alice read doc/B  -> ALLOW (判定版本 v4, 最新 v5) [旧快照] 快照放行
# 6 commit-recheck alice write doc/A -> ALLOW (判定版本 v5, 最新 v5) 重核通过 (缓冲时 v4)
# 7 commit-recheck alice write doc/B -> DENY  (判定版本 v5, 最新 v5) 重核拒绝：权限已在 v5 撤销 (缓冲时 v4 放行)
# 9 commit-recheck alice write doc/A -> ALLOW (判定版本 v5, 最新 v5) 重核通过 (缓冲时 v5)
```

- 旧命中：`#5` 长事务在撤销后仍用 v4 快照读到 doc/B。
- 新命中：`#7` 提交重核用 v5 拦截已撤销的 doc/B 写；`#6` 仍合法的 doc/A 写虽通过重核，
  因同事务 doc/B 失败而随整体中止，未落库 —— 验证"失败全不提交"。
