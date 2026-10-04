# RESULTS

环境：Node.js v22.22.1，仅标准库，单机离线。以下为本机真实运行输出。

## `node --test`

```
TAP version 13
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
  ---
  duration_ms: 652.057591
  type: 'test'
  ...
# Subtest: test/lib.test.js
ok 2 - test/lib.test.js
  ---
  duration_ms: 622.484447
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 724.150681
```

## 逐测试明细（`node test/lib.test.js` / `node test/cli.test.js`）

```
ok 1 - random corrections match brute-force recomputed roots
ok 2 - stale certificates are rejected with ERR_STALE
ok 3 - merge rules: adjacent+same generation merge, overlap or different generation stay parallel
ok 4 - LRU evicts by bytes at exact capacity boundary without breaking correctness
ok 5 - corrupted cache block is repaired from source; doubly corrupt reports ERR_SOURCE
ok 6 - invalid ranges report ERR_RANGE
# tests 6
# pass 6
# fail 0
```

```
ok 1 - CLI: ingest / certify / checkCert / correctRange / invalidate flow
ok 2 - CLI: source and cache both corrupt yields ERR_SOURCE JSON on stderr
ok 3 - CLI: bad ranges and unknown samples yield ERR_RANGE
ok 4 - CLI: merge command merges adjacent same-generation certs only
# tests 4
# pass 4
# fail 0
```

## 验收标准覆盖

1. 随机更正与暴力重算根对照 — lib 测试 1（40 轮随机 correctRange，证书根与暴力重算一致）
2. 旧证书拒绝 — lib 测试 2（更正后 checkCert 抛 ERR_STALE）
3. 相邻/重叠/代际不同合并规则 — lib 测试 3、CLI 测试 4
4. LRU 边界恰好容量 — lib 测试 4（容量 400 恰装 4 块；399 触发淘汰且正确性不变）
5. 源与缓存双坏报错 — lib 测试 5、CLI 测试 2（ERR_SOURCE）

## CLI 验收实录（`node cli.js checkCert sample cert`）

```
$ node cli.js ingest sample sample.bin --chunk 32
{"sample":"sample","blockCount":10,"size":320,"chunkSize":32}
$ node cli.js certify sample 0 9 --out cert.json
{"written":"cert.json"}
$ node cli.js checkCert sample cert.json
{"ok":true,"sample":"sample","covered":10,"generation":1}     # exit=0
$ # 修改源文件后 correctRange，再校验旧证书：
$ node cli.js correctRange sample 3 3
{"sample":"sample","corrected":1}
$ node cli.js checkCert sample cert.json
{"error":"ERR_STALE","message":"block 3 is at generation 2, certificate expects 1"}   # stderr, exit=1
```
