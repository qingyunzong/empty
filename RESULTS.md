# 真实测试结果

环境：Node.js v22.22.1，单机离线，仅标准库 + `node:test`。
测试命令：`node --test`（另用 `--test-reporter=spec` 与逐文件直跑核对子测试数）。

## 汇总（`node --test` 实际输出）

```
ok 1 - test/alarms.test.js
ok 2 - test/audit.test.js
ok 3 - test/conflict.test.js
ok 4 - test/crash.test.js
ok 5 - test/dedup.test.js
ok 6 - test/enumeration.test.js
ok 7 - test/helpers.js        # 辅助模块，无断言，被运行器一并加载
ok 8 - test/machine.test.js
ok 9 - test/transitions.test.js
# tests 9
# pass 9
# fail 0
```

逐文件子测试（直跑 `node <file>` 统计 `^ok` 行数，全部通过，共 23 项）：

| 文件 | 子测试数 | 覆盖验收项 |
|---|---|---|
| test/machine.test.js | 4 | 合法链；禁止 complete→start；禁止 cancel→assign；表外迁移全拒 |
| test/enumeration.test.js | 1 | n≤9 全序列（2,441,405 条）与独立参考状态机逐步对照 |
| test/transitions.test.js | 4 | CLI 生命周期；非法迁移退出码 3；报警阻塞/放行 complete；stderr JSON/退出码 2 |
| test/dedup.test.js | 2 | 重复投递不重复生效、重复 sync 幂等；篡改 hash 拒绝（码 2） |
| test/alarms.test.js | 3 | 未知因果 pending→前因补齐自动生效；并发 clear 拒绝；raise 未知 pending |
| test/conflict.test.js | 2 | 同人并发 assign 不同班组确定性收敛（双向均同）；安全联锁冲突 held+退出码 9 |
| test/crash.test.js | 4 | 四故障点：before-append / after-append（半索引重建）/ before-rename / after-manifest |
| test/audit.test.js | 3 | 审计通过；篡改日志审计失败（码 3）；清单缺失失败 + 日志损坏 resume 码 2 |

## 关键断言摘录（均为实际运行结果）

- 枚举对照：`sum_{k=1..9} 5^k = 2,441,405` 条序列，库状态机与
  `src/reference.js` 独立实现逐步 accept/reject 与结果状态完全一致。
- 故障点 2：崩溃后 `index.json.count=1` 而日志 2 行；`resume` 输出
  `rebuiltIndex=1`；同一事件再次 `apply` 返回 `duplicate:true`，
  工单 history 中该事件恰好出现 1 次。
- 安全联锁：`sync` 退出码 9，`heldCount=2`，冲突
  `kind=safety-interlock, status=pending`，双方工单停留 `created`。
- 确定性冲突：两方向同步结果均收敛为 `team=alpha`
  （规则 `(team, site, seq)` 字典序），`converged=true`。

## 环境备注

本运行环境中 node 子进程的管道 stdout 会被吞掉（`spawnSync(node)` 拿到空
stdout，重定向文件正常），因此 `test/helpers.js` 的 CLI 运行器统一走
`bash -c '... >out 2>err'` 文件重定向读取输出。这是测试基建的适配，
不影响被测代码路径。
