# RESULTS

- 环境：Node.js v22.22.1，仅标准库，单机离线，未访问网络。
- 命令：`node --test`
- 时间（UTC）：2026-10-03T19:28:38Z
- 结果：**3 个测试文件、11 个用例全部通过，0 失败**（总耗时约 11.1s）。

## 逐条验收

| 验收项 | 用例 | 结果 |
| --- | --- | --- |
| A 重叠命中按 (start, length, ruleId) 有序返回 | `test/scan.test.js` › A | ok |
| B 非法补丁（越界/非 JSON）拒绝且原文件不变 | `test/scan.test.js` › B；`test/cli.test.js` › exec | ok |
| C 随机小报文 + 词表 vs 朴素双重循环（50 种子） | `test/fuzz.test.js` › C | ok |
| D patch 后增量结果 == 全量重扫（含 30 种子随机补丁） | `test/scan.test.js` › D；`test/fuzz.test.js` › D2 | ok |
| E 篡改 proof（位移/轨迹摘要/行哈希/根哈希/删增命中）→ verify 失败 PROOF_MISMATCH | `test/scan.test.js` › E；`test/cli.test.js` › verify | ok |
| 错误码 DUP_RULE / OFFSET_OVERFLOW / BAD_PATCH / PROOF_MISMATCH | `test/scan.test.js` › error codes | ok |
| 规模 10 万行 × 5000 精确规则扫描 + verify | `test/scan.test.js` › scale smoke | ok |

## 原始输出（`node --test`，TAP 汇总）

```
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11113.683437
```

子用例（各文件 `node <file>` 直接运行的 TAP 行）：

```
ok 1 - A: overlapping hits returned in unified (start, length, ruleId) order
ok 2 - B: out-of-range / malformed patch rejected, file unchanged
ok 3 - D: incremental patch result equals full rescan, with interval proof
ok 4 - E: tampered proof fails verify with PROOF_MISMATCH
ok 5 - error codes: DUP_RULE and OFFSET_OVERFLOW
ok 6 - scale smoke: 100k lines, 5000 rules scan + verify
ok 1 - C: random small records vs naive double loop (50 seeds)
ok 2 - D2: random patches -> incremental equals full rescan (30 seeds)
ok 1 - CLI: scan file.jsonl rules.json prints hits/proof/stats
ok 2 - CLI exec: load/patch/scan over JSONL commands, BAD_PATCH keeps file intact
ok 3 - CLI exec: verify ok and PROOF_MISMATCH on tamper
```

## CLI 冒烟（真实进程）

```
$ node cli.js scan /tmp/demo/file.jsonl /tmp/demo/rules.json
hits: 7  root: 21b5eb7e38c662e2...  stats: {"lines":2,"exactRules":3,"regexRules":2,"hits":7,"acStates":21,"dfaStates":15,"scanMs":0.19}

$ printf '%s\n' '{"cmd":"load","file":"/tmp/demo/file.jsonl"}' '{"cmd":"patch","line":1,"text":"{...}"}' '{"cmd":"patch","line":7,"text":"{}"}' '{"cmd":"scan"}' | node cli.js exec /tmp/demo/rules.json
{"ok":true,"lines":2}
{"ok":true,"patched":1,"window":{"start":1,"end":1},...,"contextIntact":true,...}
{"error":"BAD_PATCH","message":"patch line 7 out of range [0, 2)"}
{"hits":[...],"proof":{...},"stats":{...}}
```

备注：沙箱禁止在 node 进程内再 spawn 子进程，因此 CLI 测试通过 `cli.js` 导出的 `main(argv, io)` 在进程内注入 stdio 完成；真实子进程形态经 shell 冒烟验证（见上）。
