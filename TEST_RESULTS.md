# 实际运行结果

环境: v22.22.1, npm 9.2.0, tsc Version 7.0.2
日期: 2026-10-05 11:02:56 CST

## `npm test`

```

> authz-session-snapshot@1.0.0 test
> tsc -p tsconfig.json && for f in dist/test/*.test.js; do node --test-reporter=spec "$f" || exit 1; done

▶ 会话快照绑定
  ✔ 会话打开时绑定当前版本，之后发布新版本不影响旧会话的读 (3.495323ms)
  ✔ 长事务期间旧会话可继续读旧权限，新会话读被新策略拦截 (2.722336ms)
✔ 会话快照绑定 (10.690537ms)
▶ 提交重核
  ✔ 提交按最新版本重核全部写动作：撤销命中则全不提交 (4.545994ms)
  ✔ 原子性：混合事务中一条被撤销，全部写都不落库 (0.988966ms)
  ✔ 无撤销时提交成功，全部写落库，证据为 旧允许->新允许 (1.127553ms)
  ✔ 重核用的是提交时刻的最新版本，而非会话绑定版本 (0.66227ms)
✔ 提交重核 (8.503543ms)
▶ 证据输出
  ✔ formatEvidence 输出旧/新命中明细 (1.651494ms)
✔ 证据输出 (2.511907ms)
ℹ tests 7
ℹ suites 3
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 58.049398
```

## `npm run simulate`（策略撤销与提交交错，旧/新命中证据）

```

> authz-session-snapshot@1.0.0 simulate
> tsc -p tsconfig.json && node dist/src/simulation.js

== t1 发布策略 v1: alice[doc:read,doc:write] bob[doc:read,doc:write] ==
== t2 会话 S-alice 绑定快照 v1，长事务暂存 2 条写 ==
== t3 管理员撤销 alice:doc:write，发布策略 v2 ==
== t4 旧会话读权限（快照 v1）==
  旧命中: S-alice.can(alice, doc:write) = true  (快照 v1 仍允许)
  旧命中: S-alice.can(alice, doc:read)  = true
== t5 新会话 S2-alice 绑定快照 v2 ==
  新命中: S2-alice.can(alice, doc:write) = false  (最新 v2 已撤销)
== t6 长事务提交：按最新版本 v2 重核全部写动作 ==
提交结果: 已中止（全不提交） (会话快照 v1 -> 提交时最新 v2)
  写#1 alice doc:write doc:1: 旧版本v1=allow -> 新版本v2=deny => 已拦截
  写#2 alice doc:write doc:2: 旧版本v1=allow -> 新版本v2=deny => 已拦截
  撤销命中 2 条: alice:doc:write@doc:1, alice:doc:write@doc:2
  数据库键集合: []  <- 全不提交，保持为空
== t7 新会话提交 bob 的写（v2 下仍允许）==
提交结果: 已提交 (会话快照 v2 -> 提交时最新 v2)
  写#1 bob doc:write doc:9: 旧版本v2=allow -> 新版本v2=allow => 已落库
  数据库键集合: [doc:9]  <- bob 的写正常落库
== 模拟结束 ==
```
