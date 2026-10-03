# RESULTS

测试环境：Node.js v22.22.1（仅标准库），命令 `node --test`。
记录时间（UTC）：2026-10-03T09:02:50Z。以下为真实运行输出。

## 总览（node --test，TAP 摘要）

```
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8078.399582
```

退出码：0（全量通过）。

## 分文件子测试（逐文件真实计数）

| 文件 | 子测试通过 | 失败 |
| --- | --- | --- |
| test/solver.test.js | 8 | 0 |
| test/session.test.js | 7 | 0 |
| test/verify.test.js | 7 | 0 |
| test/brute.test.js | 2 | 0 |
| test/cli.test.js | 8 | 0 |
| 合计 | 32 | 0 |

## 验收标准映射

1. **并列最优字典序确定性**：`solver.test.js`「tied optima resolve to the
   lexicographically smallest plan」「solver output is deterministic across runs」
   （含证书头哈希逐字节一致）。
2. **pin/unpin 增量与重算一致**：`session.test.js`「pin/unpin is
   incremental-consistent with a full recompute」（计划与证书头均一致）及
   「pin that forces infeasibility matches a fresh UNSAT recompute」。
3. **分叉历史 CONFLICT 定位**：`session.test.js`「merge of diverged histories
   returns CONFLICT with the earliest divergence」（index=1 及双方条目）；
   CLI 侧「merge reports CONFLICT with exit code 5 and the divergence edge」。
4. **n<=8 暴力对照**：`brute.test.js`「solver matches brute-force topological
   enumeration for n <= 8」：n=2..8 × 8 个确定性种子共 56 实例
   （SAT/UNSAT 混合），状态、makespan、计划三者全等。
   另有一次性扩大压力验证（140 实例，含 PENDING 证书重放）0 失配。

## 错误 JSON 覆盖

- `INVALID_INPUT`：非法 JSON、重复步骤 id、自环/环、未知步骤/参数、非法 compat（solver.test.js、cli.test.js）。
- `UNSAT`：内存超限、兼容矩阵清空域、钉扎导致不可行（solver.test.js、session.test.js、cli.test.js，退出码 3）。
- `PENDING`：`--max-nodes`/`--max-cert-bytes` 耗尽，保留部分证书且不判 UNSAT（solver.test.js、cli.test.js，退出码 4）。
- `CONFLICT`：分叉链合并（session.test.js、cli.test.js，退出码 5）。
- 核验失败 `INVALID`：篡改决策/头部/截断/伪造 UNSAT（verify.test.js、cli.test.js，退出码 6）。
