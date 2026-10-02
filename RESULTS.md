# RESULTS — 证据包库与 CLI 实测记录

环境：Node.js v22.22.1，仅标准库，单机离线。日期：2026-10-03。

## 1. `node --test`（测试运行器汇总）

```
✔ test/evidence.test.js (3048.601163ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3230.947048
```

## 2. 子测试明细（`node test/evidence.test.js`，TAP）

```
ok 1 - acceptance 1: random packages match brute-force per-block recomputation
ok 2 - acceptance 2: one-byte corruption fails proof and names the leaf
ok 3 - acceptance 3: scan rebuilds identical root after index loss
ok 4 - acceptance 4a: empty package packs, verifies, rejects prove/extract
ok 5 - acceptance 4b: single block (tail-only) package round-trips
ok 6 - acceptance 4c: extract spanning three blocks returns exact bytes
ok 7 - cross-leaf proof merges adjacent paths and dedupes nodes
ok 8 - index/data root mismatch yields ERR_INDEX with degraded scan root
ok 9 - length-changing corruption cannot be uniquely located: ERR_AMBIGUOUS
ok 10 - malformed index and out-of-range requests raise ERR_FORMAT / ERR_RANGE
ok 11 - CLI end-to-end: pack, prove 8 9, checkProof, extract, verify
# tests 11
# pass 11
# fail 0
```

## 3. CLI 实测（100 字节随机数据，块长 4096）

```
$ node cli.js pack data.bin idx.json
{"ok":true,"root":"086022d1870c5180e550635eac0a8a92158156491169cf11bab7d8b725d7f9f1","blockCount":1}

$ node cli.js verify data.bin idx.json
{"ok":true,"root":"086022d1870c5180e550635eac0a8a92158156491169cf11bab7d8b725d7f9f1","blockCount":1}

$ node cli.js prove data.bin idx.json 8 9   # exit=0，输出写入 proof.json
{
  "format": "evidence-proof/1",
  "blockSize": 4096,
  "fileSize": 100,
  "blockCount": 1,
  "range": { "offset": 8, "length": 9 },
  "firstLeaf": 0,
  "lastLeaf": 0,
  "leaves": [
    { "index": 0, "offset": 0, "length": 100,
      "sha256": "086022d1870c5180e550635eac0a8a92158156491169cf11bab7d8b725d7f9f1" }
  ],
  "path": [],
  "root": "086022d1870c5180e550635eac0a8a92158156491169cf11bab7d8b725d7f9f1"
}

$ node cli.js checkProof proof.json
{"ok":true,"root":"086022d1870c5180e550635eac0a8a92158156491169cf11bab7d8b725d7f9f1"}

$ node cli.js extract data.bin idx.json 8 9 | xxd
00000000: 498e 0f19 6050 b8e5 94                   I...`P...
```

## 4. 单比特损坏（offset 50 翻转 1 bit）

```
$ node cli.js verify data.bin idx.json   # stderr，exit=1
{"error":"ERR_ROOT","message":"data does not match index; minimal corrupted leaf set: [0]","leaves":[0],"expected":"086022d1870c5180e550635eac0a8a92158156491169cf11bab7d8b725d7f9f1","actual":"6e2ca92fcc4253a1a2e2a9e2a537195b4ee39cea92dba7fcd3d7caa666c9178e"}
```

## 5. 删除索引后降级扫描重建

```
$ rm idx.json && node cli.js scan data.bin   # exit=0
{"ok":true,"root":"6e2ca92fcc4253a1a2e2a9e2a537195b4ee39cea92dba7fcd3d7caa666c9178e","blockCount":1}
```

扫描重建的根与损坏后数据的实际根一致（即上节 `actual` 值），
与原始索引根比对即可判定数据被改动。
