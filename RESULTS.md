# RESULTS

日期:2026-10-03(Asia/Shanghai)
运行时:`node v22.22.1`,仅标准库,测试框架 `node:test`
命令:`node --test`(全量)

## 全量结果(真实输出,未删减关键行)

```
ok 1 - test/audit.test.js
ok 2 - test/certify.test.js
ok 3 - test/cli.test.js
ok 4 - test/enumerate.test.js
ok 5 - test/journal.test.js
ok 6 - test/lab.test.js
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

退出码:0。6 个测试文件全部通过(共 35 个断言型子测试)。

## 验收对照

| 验收项 | 测试 | 结果 |
| --- | --- | --- |
| 1. 断链导致 REFUTE 最小核心 | `test/certify.test.js` "acceptance 1: broken chain -> REFUTE with deletion-minimal core"(核心可重放 REFUTE 且逐事实删除即失效) | ok |
| 2. 缺少环境窗为 INSUFFICIENT 而非 UNSAT | `test/certify.test.js` "acceptance 2: missing environment window -> INSUFFICIENT_EVIDENCE, never REFUTE" | ok |
| 3. 预算边界 PENDING | `test/certify.test.js` "acceptance 3: budget boundary band -> PENDING, not REFUTE"(另有明显超预算 -> REFUTE、租用占用 -> PENDING/STANDARD_BUSY) | ok |
| 4. n<=8 枚举标准器链对照 | `test/enumerate.test.js`:400 个随机实验室(2-8 器、随机链/环/域/有效期/租用),回溯求解器与朴素枚举的有效链集合、最终判定、证书哈希完全一致;四类判定(CERT/REFUTE/INSUFFICIENT/PENDING)均被覆盖 | ok |
| 持久化与崩溃恢复 | `test/journal.test.js`:撕裂尾部(半帧)、CRC 损坏、短于帧头的垃圾均被截断,恢复后日志可继续追加,绝不出现半条 measure;`atomicWriteFile` 崩溃(残留 tmp)不影响旧状态 | ok |

## 关键语义测试(test/certify.test.js,真实输出)

```
ok 1 - CERT: valid chain, combined uncertainty, chain and hash in certificate
ok 2 - acceptance 1: broken chain -> REFUTE with deletion-minimal core
ok 3 - acceptance 2: missing environment window -> INSUFFICIENT_EVIDENCE, never REFUTE
ok 4 - missing measurement and missing links -> INSUFFICIENT_EVIDENCE, never REFUTE
ok 5 - acceptance 3: budget boundary band -> PENDING, not REFUTE
ok 6 - budget clearly exceeded -> REFUTE with BUDGET_EXCEEDED core
ok 7 - env reading outside window -> REFUTE (ENV_OUT_OF_WINDOW)
ok 8 - expired standard -> REFUTE (EXPIRED)
ok 9 - uncertainty inversion (standard worse than required) -> REFUTE
ok 10 - cycle in traceability chain -> REFUTE (CYCLE)
ok 11 - domain mismatch (range class) -> REFUTE (RANGE_MISMATCH)
ok 12 - leased standard blocks its chain -> PENDING (STANDARD_BUSY), freed after release
ok 13 - alternative free chain is used when another standard is leased
```

## 其余测试文件

- `test/lab.test.js`(5 项):实体校验、link/unlink 约束(UNLINK_BLOCKED)、
  reserve/release 成对与 `LEASE_STATE`、measure 校验。
- `test/audit.test.js`(5 项):VALID 重放、字段篡改 TAMPERED、重哈希后推导
  不符 REPLAY_MISMATCH、出证后实验记录被改 STATE_DIVERGED、未知证书。
- `test/cli.test.js`(4 项):端到端建库-测量-出证-审计;LEASE_STATE 与
  UNLINK_BLOCKED 的退出码;测量日志崩溃恢复(进程内驱动 `runCli`,因沙箱
  禁止子进程);未知命令。

## 备注

- 沙箱禁止 `child_process` 派生,CLI 通过 `cli.js` 导出的 `runCli(argv)`
  进程内测试;`node cli.js ...` 直接运行行为一致(已手工验证出证链路)。
- `measure` 是唯一落盘命令:帧式日志 append+fsync;其余状态经
  `state.json` 原子替换(tmp+fsync+rename+dir fsync)。
