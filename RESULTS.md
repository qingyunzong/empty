# 实际运行结果

环境：Node.js v22.22.1，npm 9.2.0，TypeScript 7.0.2（全局 tsc），Linux。
日期：2026-10-05。

## npm run typecheck

```
> tsc --noEmit
（无输出，退出码 0）
```

## npm test

```
> tsc -p tsconfig.build.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/simulator.test.js
ok 1 - dist/test/simulator.test.js
  ---
  duration_ms: 223.790016
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 240.270838
```

测试文件内 6 个用例全部通过（`node dist/test/simulator.test.js` 明细）：

```
ok 1 - shared segment is mutually exclusive while two arms swap items
ok 2 - failed action releases only its own resources, in reverse order
ok 3 - circular wait is detected and the wait-for graph is emitted
ok 4 - snapshots at arbitrary events replay with item uniqueness and resource conservation
ok 5 - rollback undoes picks and places along the reverse path
ok 6 - action ending while still holding locks is failed and rolled back
# tests 6
# pass 6
# fail 0
```

## npm run demo（关键输出）

场景 1（双臂经共享段 S 交换物品，每 5 个事件存一次快照）：

```
#007 [t=03] acquired arm=r1 segment=S
#009 [t=03] blocked arm=r2 segment=S holders=[r1]
...
#015 [t=08] released arm=r1 segment=S cause=step
#016 [t=08] unblocked arm=r2 segment=S
...
snapshots saved: snap@2, snap@7, snap@12, snap@17, snap@22
replay: 27 events, violations: 0
replay final state matches live: true
snapshot snap@2 @ event #3: replay match = true
snapshot snap@7 @ event #8: replay match = true
snapshot snap@12 @ event #13: replay match = true
snapshot snap@17 @ event #18: replay match = true
snapshot snap@22 @ event #23: replay match = true
```

场景 2（循环等待 → 输出等待图 → 牺牲品逆序回滚）：

```
#004 [t=02] blocked arm=r1 segment=S2 holders=[r2]
#005 [t=02] blocked arm=r2 segment=S1 holders=[r1]
#006 [t=02] deadlock cycle=r1 -> r2 -> r1
#007 [t=02] action_failed arm=r1 action=r1-forward reason="deadlock victim of cycle r1 -> r2 -> r1"
#008 [t=02] released arm=r1 segment=S1 cause=rollback
#009 [t=02] unblocked arm=r2 segment=S1
...
wait-for graph (DOT):
digraph wait_for {
  "r1";
  "r2";
  "r1" -> "r2";
  "r2" -> "r1";
}
replay: 14 events, violations: 0
replay final state matches live: true

DEMO OK
```
