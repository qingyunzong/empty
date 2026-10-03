# RESULTS

环境：Node.js v22.22.1，仅标准库，单机离线。以下均为真实运行输出。

## 1. `node --test`（验收入口）

```
TAP version 13
# Subtest: test/main.test.js
ok 1 - test/main.test.js
  ---
  duration_ms: 3672.346323
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
# duration_ms 3888.959651
```

逐条子测试（`node test/main.test.js`，同一测试文件）：

```
ok 1 - random ranges match brute-force slice of source
ok 2 - out-of-range reads return ERR_RANGE, never empty
ok 3 - flipping index bloom bitmap is detected by verifyIndex
ok 4 - bloom negative yields ERR_BLOOM miss without touching data
ok 5 - truncated data (last block removed) has deterministic boundary behavior
ok 6 - interval N=1 (checkpoint per block)
ok 7 - interval N greater than blockCount (single checkpoint)
ok 8 - interval N=1 with single block and empty file edge cases
ok 9 - repair reproduces index bytes exactly and deterministically
ok 10 - corrupted payload yields ERR_CRC on read and verify
ok 11 - CLI: build/read/verify/repair with JSON errors on stderr
# tests 11
# pass 11
# fail 0
```

验收点映射：1→子测试 1/2；2→子测试 3/4；3→子测试 5；4→子测试 6/7/8；5→子测试 9；另覆盖 ERR_CRC（10）与 CLI 端到端（11）。

## 2. CLI 真实运行（5000 字节随机源，blockSize=256，N=3）

```
$ node cli.js build src.bin data.bin data.idx 256 3
{"ok":true,"blockCount":20,"dataSize":5000,"blockSize":256,"interval":3}

$ node cli.js read data.bin data.idx 100 37 | xxd
00000000: 07b3 2a52 d621 7cba 0827 36bf 191e c224  ..*R.!|..'6....$
00000010: 7abb 09ae b98e 0ad5 1e32 75e2 310f fab2  z........2u.1...
00000020: 5391 df7c 8d                             S..|.

$ dd if=src.bin bs=1 skip=100 count=37 | xxd   # 暴力对照，字节一致
00000000: 07b3 2a52 d621 7cba 0827 36bf 191e c224  ..*R.!|..'6....$
00000010: 7abb 09ae b98e 0ad5 1e32 75e2 310f fab2  z........2u.1...
00000020: 5391 df7c 8d                             S..|.

$ node cli.js verify data.bin data.idx
{"ok":true}

$ node cli.js read data.bin data.idx 4990 37    # 越界
{"error":"ERR_RANGE","message":"range out of bounds"}
exit=1
```

## 3. 索引篡改 → 检出 → repair 字节复现

```
$ python3 -c "d=bytearray(open('data.idx','rb').read()); d[70]^=0xff; open('data.idx','wb').write(d)"
$ node cli.js verify data.bin data.idx
{"error":"ERR_INDEX","message":"index does not match data (tampered or stale)"}
exit=1

$ node cli.js repair data.bin data.idx
{"ok":true,"checkpointCount":7,"bytes":664}

$ node cli.js verify data.bin data.idx
{"ok":true}

$ cmp data.idx idx.orig && echo 索引字节与原始完全一致
索引字节与原始完全一致
```
