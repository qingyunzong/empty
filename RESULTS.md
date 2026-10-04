# 验收结果（真实运行记录）

- 日期：2026-10-04
- 运行时：v22.22.1（仅标准库 + node:test，单机离线）
- 命令：`node --test`，退出码 0

## 总览

```
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

5 个测试文件全部通过，共 28 个子测试：

| 文件 | 子测试 | 结果 |
|---|---|---|
| test/validation.test.js | 10 | 全过 |
| test/sync.test.js | 5 | 全过 |
| test/faults.test.js | 4 | 全过 |
| test/cert.test.js | 6 | 全过 |
| test/paths.test.js | 3 | 全过 |

## 验收点对照

- **合批守恒越界**：`merge A:50+B:50 -> C:120`（tol 默认 1e-9）被拒，exit 2，
  stderr `{"ok":false,"code":2,"error":"conservation violation",...}`
  （test/validation.test.js:5）
- **循环 relabel**：`A->B` 后再 `B->A` 被拒，exit 2（test/validation.test.js:25）；
  自环 `A->A` 同拒（test/validation.test.js:34）
- **三故障点**（test/faults.test.js，`LOT_FAULT` 注入，子进程真实 exit 70 后 resume）：
  - edge log fsync 前（含撕裂写 `LOT_FAULT_TEAR=1`）：恢复截断撕裂尾，events=0，无半条边
  - edge log fsync 后：事件恰好恢复一次，重开不重放
  - snapshot rename 前：旧快照字节不变，日志重放补齐，tmp 清理
  - cert manifest commit 后：manifest 恰 1 条、证书文件恰 1 个，重试 prove 幂等无双证书
- **n≤8 祖先路径独立枚举对照**（test/paths.test.js）：
  n≤4 全部 64 个 DAG、n=5 全部 1024 个 DAG 穷举；n∈{6,7,8} 各 300 个随机 DAG；
  库内 `pathsTo`/`ancestry` 与测试内独立暴力枚举逐路径比对一致
- **双向同步**：VV 差量交换收敛，重复 sync 零增量（幂等）；
  未知父批进 pending（exit 3），父批到达后自动补全收敛（exit 0），不直接失败
- **证书**：prove/verify 正常通过；篡改质量 exit 7；删边（诚实重算链）exit 7；
  注入回环边 exit 7；pending 触及谱系时 prove exit 3

## 完整 TAP 摘要

```
ok 1 - test/cert.test.js
ok 2 - test/faults.test.js
ok 3 - test/paths.test.js
ok 4 - test/sync.test.js
ok 5 - test/validation.test.js
```
