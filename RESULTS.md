# RESULTS

运行环境：Node.js v22.22.1，离线单机，仅标准库。运行时间：2026-10-07。

## `node --test`（真实输出，退出码 0）

```
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
# Subtest: test/graph.test.js
ok 2 - test/graph.test.js
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 546.720521
```

## 子测试明细（`node test/graph.test.js` / `node test/cli.test.js`）

```
ok 1 - 1: incremental reweight keeps path and cost correct
ok 2 - 2: close distinguishes detour from true disconnect
ok 3 - 2b: lexicographic tie-break is stable among equal-cost paths
ok 4 - 3: exhaustive brute-force cross-check on random graphs (n<=8)
ok 5 - 4: three consecutive undos restore state three mutations back
ok 6 - 4b: undo restores closed/open state and cost snapshots
ok 7 - 5: forged, stale or version-mismatched certificates fail verify
ok 8 - input validation and conflict error codes
ok 9 - query from a node to itself has cost 0
# tests 9
# pass 9
# fail 0

ok 1 - cli: JSONL command session end to end
ok 2 - cli: verify accepts fresh cert and rejects tampered/stale ones
ok 3 - cli: every response is a single JSON object with ok or error
# tests 3
# pass 3
# fail 0
```

## 验收条目对照

1. **增量改权正确**：测试 1 —— `set_cost` 后路径与成本即时正确（20→8→6），
   每次证书均可核验。
2. **绕行与断连区分**：测试 2 —— 封闭最短路边后走无环绕行边（cost 5），
   再封闭唯一通路后返回 `NO_PATH`；`open` 后恢复。
3. **n<=8 全图枚举对照**：测试 3 —— 60 个随机种子图（含随机
   close/open/set_cost 变更），所有节点对与暴力枚举全部简单路径的
   (成本, 字典序) 最优解逐一比对，并核验每份证书。
4. **连续 undo 恢复三层前状态**：测试 4 —— 4 层变更后连续 3 次 undo，
   查询结果逐层回退，第 3 次后与第 1 层状态完全一致；空栈 undo 返回
   `CONFLICT`。
5. **篡改证书必失败**：测试 5 —— 13 种篡改（改成本/路径/势/版本/缺势等）
   及过期证书全部返回 `CERT_INVALID`；CLI 测试覆盖跨会话版本不符场景。

## 规模性能（n=200, m=3000, 命令=5000 混合负载）

```
n=200 m=3000 cmds=5000 queries=2076 verifies=228 total=3925.0ms
```

## CLI 真实管道冒烟（`printf ... | node cli.js`，节选）

```
{"ok":true,"path":["DOCK","WS1","WS2"],"cost":8,"cert":{"version":3,...}}
{"ok":false,"error":"NO_PATH","message":"no path from DOCK to WS2"}
{"ok":false,"error":"CERT_INVALID","message":"certificate validation failed"}
{"ok":false,"error":"INVALID_INPUT","message":"... not valid JSON"}
```
