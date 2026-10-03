# RESULTS

环境：Node.js v22.22.1，仅标准库，单机离线，未访问网络与外部数据。
日期：2026-10-03。命令：`node --test`（退出码 0）。

## 测试套件真实输出（摘要）

```
ok 1 - test/a_order.test.js
ok 2 - test/b_patch.test.js
ok 3 - test/c_naive.test.js
ok 4 - test/d_incremental.test.js
ok 5 - test/e_proof.test.js
ok 6 - test/errors.test.js
# tests 6
# pass 6
# fail 0
# duration_ms 2299.535383
```

## 验收项覆盖

- A 重叠命中按序返回：`test/a_order.test.js`
  （精确/正则混合重叠命中，断言全局按 (start, length, ruleId) 严格升序）。
- B 非法补丁越界拒绝且原文件不变：`test/b_patch.test.js`
  （line 为 0/-1/越界/非整数/字符串均 BAD_PATCH；非法记录 BAD_PATCH；
  逐字节比对文件未变；合法 patch 仅改写目标行）。
- C 随机对照：`test/c_naive.test.js`
  （固定种子 200 轮随机文本/词表/正则，与朴素双重循环 + JS RegExp 锚定
  逐命中 deepEqual）。
- D patch 后增量等于重扫：`test/d_incremental.test.js`
  （对 8 行文件逐行 patch，会话内增量命中与全新全量重扫 deepEqual，
  窗口证明为 [line, line]）。
- E 篡改 proof 必须失败：`test/e_proof.test.js`
  （原始 proof verify 通过；篡改 hitsHash/trajHash/fileHash/rulesHash/
  lineCount/轨迹条目/删除轨迹条目 共 8 种均 PROOF_MISMATCH；
  文件被改动后旧 proof 亦失败——不依赖 mtime）。
- 错误码补充：`test/errors.test.js`
  （DUP_RULE：重复 id 与重复精确串；OFFSET_OVERFLOW：100001 行文件被拒）。

## CLI 冒烟（真实运行，/tmp/clidemo）

- `node cli.js scan msg.jsonl rules.json`：ok，3 行 4 规则，33 命中，输出 hits/proof/stats。
- JSONL 命令模式 load → patch(line 2) → scan：
  `load ok stats={"lines":3,"exactRules":2,"regexRules":2,"hits":33,...}`；
  `patch ok window=[2,2] stats.hits=34`；`scan ok hits=34`。
- `node cli.js verify msg.jsonl rules.json proof.json`：`{"ok":true,"verified":true,"hits":34}`。
- 篡改 hitsHash 后 verify：`{"ok":false,"error":"PROOF_MISMATCH"}`，退出码 1。

## 规模冒烟（真实运行，上限：10 万行 / 5000 规则）

100000 行 × 5000 规则（4999 精确 + 1 正则 `[0-9]+`，命中极密场景）：

```
load+fullscan ms 8409  stats {"lines":100000,"exactRules":4999,"regexRules":1,"hits":4337600,"acStates":5001,"dfaStates":2}
incremental patch ms 4386  window [50000,50000]   # 耗时主要为构造 433 万条命中返回数组，重扫仅 1 行
full rescan ms 16002  equal: true                  # 增量结果 == 全量重扫
```

另验证：5001 条规则被 OFFSET_OVERFLOW 拒绝（上限校验生效）。
