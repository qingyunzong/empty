# RESULTS

环境: v22.22.1, 仅标准库, node:test, 单机离线

## 测试: `node --test`

```
TAP version 13
# Subtest: test/delta.test.js
ok 1 - test/delta.test.js
  ---
  duration_ms: 1970.330718
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
# duration_ms 2029.394653
```

## 测试明细: `node test/delta.test.js`

```
ok 1 - 1. small tree: add/delete/modify round-trip matches target byte-for-byte
ok 2 - 2. duplicate content stored once with correct reference counts
ok 3 - 2b. tied best matches break by path byte order, then offset
ok 4 - 3. interrupted apply leaves target clean and resumes to completion
ok 5 - 4. case conflicts and illegal paths are rejected with ERR_PATH
ok 6 - 5. empty-to-empty delta has a deterministic root
ok 7 - certify reports ERR_GAP for uncovered bytes and ERR_HASH for corruption
ok 8 - CLI: scan/makedelta/applydelta/certify round-trip and JSON stderr errors # SKIP child_process spawn not permitted in this environment
# tests 8
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 1
# todo 0
```

注: 第 8 项 CLI 测试在当前沙箱中被跳过 (EPERM: 禁止 node 派生子进程);
CLI 等价流程已直接在 shell 中真实执行, 输出如下。

## CLI 端到端: scan → makedelta → applydelta → certify

```
$ # build demo trees
$ node cli.js scan src --chunk-size 16 > src.json   # (same for dst)
$ node cli.js makedelta src.json dst.json dst > delta.json
$ # delta summary:
{
  "targetRoot": "f17ce15139503deb44ab765789d9617bc5ce2929f0a738b391ef9fc8000824cc",
  "plan": [
    "a.txt",
    "sub/b.txt",
    "sub/deep/d.txt"
  ],
  "delete": [
    "c.bin"
  ],
  "literalBlocks": 5
}
$ node cli.js applydelta delta.json work
{"applied":true,"targetRoot":"f17ce15139503deb44ab765789d9617bc5ce2929f0a738b391ef9fc8000824cc","files":3,"deleted":1}
$ node cli.js certify work delta.json
{
  "ok": true,
  "targetRoot": "f17ce15139503deb44ab765789d9617bc5ce2929f0a738b391ef9fc8000824cc",
  "files": [
    {
      "path": "a.txt",
      "size": 41,
      "chunks": 3,
      "coveredBytes": 41
    },
    {
      "path": "sub/b.txt",
      "size": 37,
      "chunks": 3,
      "coveredBytes": 37
    },
    {
      "path": "sub/deep/d.txt",
      "size": 37,
      "chunks": 3,
      "coveredBytes": 37
    }
  ],
  "totalFiles": 3,
  "totalChunks": 9,
  "totalCoveredBytes": 115,
  "computedRoot": "f17ce15139503deb44ab765789d9617bc5ce2929f0a738b391ef9fc8000824cc"
}
$ diff -r work dst
(no output: trees identical)
$ # corrupt one byte, then certify
{"error":"ERR_HASH","message":"hash mismatch in a.txt@0"}
exit=1
```
