# RESULTS — 证据包（evidence pack）库与 CLI 验收记录

环境：Node.js v22.22.1，仅标准库（`node:crypto` / `node:fs` / `node:test`），单机离线。
日期：2026-10-03。

## 设计要点

- 定长块（默认 4096，可配）+ 变长尾块；块表记录 `index / offset / length / sha256`。
- 叶哈希 `sha256("EVLEAF1" | index:u64be | length:u64be | sha256(block))`，
  内部节点 `sha256("EVNODE1" | left | right)`，奇数节点直接晋升；空包根为 `sha256("EVEMPTY1")`。
- 索引 `idx.json` 保存块表与 Merkle 根；证明只含请求区间覆盖的叶 + 去重后的兄弟路径，
  `checkProof` 仅凭（根, 路径, 区间）即可离线复核。
- 跨叶证明按层只收集区间边界的兄弟节点，等价于逐叶路径合并后去重（测试 7 验证）。
- 错误一律 stderr 单行 JSON：`ERR_FORMAT / ERR_ROOT / ERR_PROOF / ERR_RANGE / ERR_AMBIGUOUS / ERR_INDEX`，退出码 1（用法错误为 2）。

## 1. 测试运行（真实输出）

`node --test`：

```
TAP version 13
# Subtest: test/evidence.test.js
ok 1 - test/evidence.test.js
  ---
  duration_ms: 2970.289601
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
# duration_ms 3216.364016
```

逐子测试（`node test/evidence.test.js`，11/11 通过）：

```
ok 1 - acceptance 1: random packages match brute-force per-block recomputation
ok 2 - acceptance 2: one-byte flip fails proof and names the leaf
ok 3 - acceptance 3: deleted index, degraded scan rebuilds identical root
ok 4 - acceptance 4a: empty package
ok 5 - acceptance 4b: single block package
ok 6 - acceptance 4c: extract spanning three blocks
ok 7 - cross-leaf proof merges adjacent paths and dedupes siblings
ok 8 - checkProof rejects tampered leaf and wrong root with ERR_PROOF
ok 9 - size change makes corruption unlocalizable: ERR_AMBIGUOUS
ok 10 - out-of-range requests yield ERR_RANGE
ok 11 - malformed index yields ERR_FORMAT
1..11
# tests 11
# pass 11
# fail 0
```

## 2. CLI 验收会话（真实输出，块大小 64）

```
$ head -c 200 /dev/urandom > sample.bin
$ node cli.js pack sample.bin data.bin idx.json 64
{"ok":true,"command":"pack","root":"ecb377220885770fcea96617f40b8155054f3e75ca7beb81b8b57669919d93e0","blocks":4,"totalSize":200,"blockSize":64,"data":"data.bin","index":"idx.json"}

$ node cli.js verify data.bin idx.json
{"ok":true,"command":"verify","root":"ecb377220885770fcea96617f40b8155054f3e75ca7beb81b8b57669919d93e0","blocks":4,"totalSize":200}

$ node cli.js prove data.bin idx.json 8 9 proof.json
{"ok":true,"command":"prove","root":"ecb377220885770fcea96617f40b8155054f3e75ca7beb81b8b57669919d93e0","offset":8,"length":9,"startLeaf":0,"leaves":1,"siblings":2,"proof":"proof.json"}

$ node cli.js checkProof proof.json
{"ok":true,"command":"checkProof","root":"ecb377220885770fcea96617f40b8155054f3e75ca7beb81b8b57669919d93e0","offset":8,"length":9,"leaves":1}

$ node cli.js extract data.bin idx.json 59 70 span.bin   # 跨 3 块（块 0/1/2）
{"ok":true,"command":"extract","offset":59,"length":70,"out":"span.bin","sha256":"048d2c78cfff2724f0a49b825ab9177a834ba5cea5062111b808ac7b0b9f41f1"}
$ cmp <(dd if=data.bin bs=1 skip=59 count=70) span.bin && echo OK
extract matches source slice

# 验收 3：删索引后降级扫描，根一致
$ mv idx.json idx.saved
$ node cli.js verify data.bin idx.json 64
{"ok":true,"command":"verify","degraded":"scan","reason":"index missing","root":"ecb377220885770fcea96617f40b8155054f3e75ca7beb81b8b57669919d93e0","blocks":4,"totalSize":200,"blockSize":64}
degraded-scan exit=0 (root 与 pack 根一致)

# 验收 2：改 1 字节（偏移 100，属叶 1），verify/prove 失败并指出叶
$ printf '\x01' | dd of=data.bin bs=1 seek=100 conv=notrunc
$ node cli.js verify data.bin idx.json
{"ok":false,"code":"ERR_INDEX","message":"data and index roots disagree; degraded scan located mismatching leaves","leaves":[1],"indexRootConsistent":true,...}
verify-corrupted exit=1
$ node cli.js prove data.bin idx.json 8 9
{"ok":false,"code":"ERR_ROOT","message":"data does not match index at 1 block(s)","leaves":[1]}
prove-corrupted exit=1
```

## 3. 验收标准对照

| # | 标准 | 结果 |
|---|------|------|
| 1 | 随机小包与暴力逐块重算对照 | 测试 1（8 种尺寸 0..1000 字节，块表与根逐一比对）✔ |
| 2 | 改 1 字节证明失败且指出叶 | 测试 2 + 上方 CLI 会话（`leaves:[1]`）✔ |
| 3 | 删索引后扫描重建根一致 | 测试 3 + 上方 CLI 会话 ✔ |
| 4 | 空包、单块、跨三块提取 | 测试 4a/4b/4c + 上方 extract ✔ |
