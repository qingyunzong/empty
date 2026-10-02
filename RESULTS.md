# RESULTS

日期：2026-10-03 ｜ 环境：Node.js v22.22.1（仅标准库，node:test，单机离线）

## 1. `node --test`（验收入口）

```
TAP version 13
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
  ---
  duration_ms: 6414.148206
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
# duration_ms 6511.721682
```

## 2. 逐测试明细（`node test/acceptance.test.js`，TAP）

```
TAP version 13
ok 1 - acceptance 1: random corrections match brute-force recomputed root
ok 2 - acceptance 2: stale certificates are rejected with ERR_STALE
ok 3 - acceptance 3: merge rules for adjacent / overlapping / divergent certs
ok 4 - acceptance 4: LRU eviction at exact byte capacity
ok 5 - acceptance 5: corrupt cache repaired, corrupt cache+source -> ERR_SOURCE
ok 6 - error mapping: ERR_RANGE and ERR_CRC
ok 7 - invalidate drops cached blocks and overlapping certificates
ok 8 - cli: ingest / certify / correctRange / checkCert end to end
ok 9 - cli: merge adjacent certs, keep overlapping ones side by side
1..9
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 34618.982113
```

## 3. CLI 演示（`node cli.js ...`，真实输出）

```
$ node cli.js ingest sample.bin --block-size 128 --capacity 512
{"ok":true,"sample":"/tmp/demo/sample.bin","cacheDir":"sample.bin.cache","size":1024,"blockSize":128,"blockCount":8,"capacity":512,"cachedBytes":512,"cachedBlocks":4,"root":"5d52eda503eb494aae8790e9ef85c1e7aa3236df6cfb67c11d0f7d4419e7d1a3","storedCerts":0}
$ node cli.js certify sample.bin 0 512 --out cert.json
$ node cli.js checkCert sample.bin cert.json
{"ok":true,"window":[0,4],"covered":4,"repaired":0,"root":"42eff9a851ff51fd50f32f1cbefb6f0297fb5bb688778573a968f0e52bfa03e8"}
$ node cli.js correctRange sample.bin 10 20 --fill 7
{"ok":true,"firstBlock":0,"lastBlock":0}
$ node cli.js checkCert sample.bin cert.json   # stale cert
{"error":"ERR_STALE","message":"block 0 generation 1 != certified 0"}
exit code: 1
$ node cli.js info sample.bin
{"sample":"/tmp/demo/sample.bin","cacheDir":"sample.bin.cache","size":1024,"blockSize":128,"blockCount":8,"capacity":512,"cachedBytes":512,"cachedBlocks":4,"root":"317c677c4e89213cf0655766db3767a7ca04c35c1fc77a23bfa274331f562fbf","storedCerts":1}
```
