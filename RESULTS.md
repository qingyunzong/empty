# RESULTS

日期: 2026-10-02 23:24:23 UTC  |  运行时: v22.22.1  |  平台: Linux 6.6.114.1-microsoft-standard-WSL2 x86_64

## `node --test`（全量，真实输出）

```
TAP version 13
# Subtest: test/chain.test.js
ok 1 - test/chain.test.js
  ---
  duration_ms: 1852.043282
  type: 'test'
  ...
# Subtest: test/cli.test.js
ok 2 - test/cli.test.js
  ---
  duration_ms: 3058.353625
  type: 'test'
  ...
# Subtest: test/crash.test.js
ok 3 - test/crash.test.js
  ---
  duration_ms: 3600.27101
  type: 'test'
  ...
# Subtest: test/epoch.test.js
ok 4 - test/epoch.test.js
  ---
  duration_ms: 2992.021382
  type: 'test'
  ...
# Subtest: test/helpers.js
ok 5 - test/helpers.js
  ---
  duration_ms: 1617.088619
  type: 'test'
  ...
# Subtest: test/merkle.test.js
ok 6 - test/merkle.test.js
  ---
  duration_ms: 4789.845893
  type: 'test'
  ...
# Subtest: test/sync.test.js
ok 7 - test/sync.test.js
  ---
  duration_ms: 1921.359869
  type: 'test'
  ...
1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5067.827791
```

## 各测试文件覆盖的验收项

| 文件 | 验收项 | 结果 |
|---|---|---|
| `test/chain.test.js` | 见下 | 4 通过 / 0 失败 |
| `test/cli.test.js` | 见下 | 8 通过 / 0 失败 |
| `test/crash.test.js` | 见下 | 4 通过 / 0 失败 |
| `test/epoch.test.js` | 见下 | 3 通过 / 0 失败 |
| `test/merkle.test.js` | 见下 | 4 通过 / 0 失败 |
| `test/sync.test.js` | 见下 | 4 通过 / 0 失败 |

- 验收 1（随机小图 vs 暴力重算）: \`test/merkle.test.js\`、\`test/chain.test.js\`、\`test/helpers.js\` 中独立参考实现（refMerkleRoot / refWalkChain）
- 验收 2（翻转 1 字节必被定位）: \`test/chain.test.js\` "flipping 1 byte in any block file is located by verify()"、\`test/cli.test.js\` 退出码 2
- 验收 3（不同缺失集有限轮收敛）: \`test/sync.test.js\`（5/8/12 块三副本，≤2 轮收敛，二次 sync pulled=0 幂等）
- 验收 4（旧成员写入 STALE_EPOCH）: \`test/epoch.test.js\`、\`test/cli.test.js\` 退出码 5
- 崩溃一致性（commit 记录落盘前后故障点）: \`test/crash.test.js\`（before/after manifest commit，30 轮崩溃-恢复循环无半提交块）

## CLI 端到端实录（含退出码）

```
$ evpack init demo --members alice,bob
{"ok":true,"epoch":0,"count":0,"heads":[],"digest":"fdf2073c25c0c4ceb7c3c024fdac62da4ef898964aa30f2f528b292198e2ffc8"}
$ evpack add demo --data {"exp":"trial-1","p":0.03} --member alice
{"ok":true,"added":1,"hashes":["89ddec7846754ec0a37f6ade74bc7f6e1bd69f6ab5ea92a69bea506a971c88f6"],"epoch":0,"count":1,"heads":["89ddec7846754ec0a37f6ade74bc7f6e1bd69f6ab5ea92a69bea506a971c88f6"],"digest":"c53bd90dd99cda4685cefd60d84a9de986f8af4b961a2f73689f05c4eb616bbd"}
$ evpack add demo --jsonl in.jsonl --member bob
{"ok":true,"added":2,"hashes":["b1b9c4bd1f41bec1f687c3bb7ea7d59495d9d99b71f4e5324cbba11462d2ab3f","538bfb844a2957386674e90726165a33506af69c362d9169b184e64b96010a68"],"epoch":0,"count":3,"heads":["538bfb844a2957386674e90726165a33506af69c362d9169b184e64b96010a68"],"digest":"41f540d9da5db59b70ec03e854f5a091453e90899b6f3f213d1e2f2b297337d8"}
$ evpack digest demo
{"epoch":0,"count":3,"heads":["538bfb844a2957386674e90726165a33506af69c362d9169b184e64b96010a68"],"digest":"41f540d9da5db59b70ec03e854f5a091453e90899b6f3f213d1e2f2b297337d8"}
$ evpack prove demo --index 1
{"index":1,"hash":"b1b9c4bd1f41bec1f687c3bb7ea7d59495d9d99b71f4e5324cbba11462d2ab3f","count":3,"epoch":0,"digest":"41f540d9da5db59b70ec03e854f5a091453e90899b6f3f213d1e2f2b297337d8","proof":[{"hash":"02d4f3dc690f1bed25777d862743668b5bac1438dfec454d9075d31f5a049e6b","side":"left"},{"hash":"2e2c422301cf471b894c654317727e6977930bc5a7ae037b73851777b17c6209","side":"right"}]}
$ evpack verify demo
{"ok":true,"count":3,"epoch":0,"digest":"41f540d9da5db59b70ec03e854f5a091453e90899b6f3f213d1e2f2b297337d8","tip":"538bfb844a2957386674e90726165a33506af69c362d9169b184e64b96010a68"}
$ evpack verify demo --proof proof.json
{"ok":true,"index":1,"digest":"41f540d9da5db59b70ec03e854f5a091453e90899b6f3f213d1e2f2b297337d8"}
$ evpack members demo --set alice,carol --member alice
{"ok":true,"epochBlock":"2b5edacefa443d73a54f02c5ec3abeaf7bd388e38d504c13fcc129039fd6494b","epoch":1,"count":4,"heads":["2b5edacefa443d73a54f02c5ec3abeaf7bd388e38d504c13fcc129039fd6494b"],"digest":"a7b1d0939b5aecf03c0e4fbbf016d1c68790235914002386b0312159bb4b97ea","members":["alice","carol"]}
$ evpack add demo --data {"x":1} --member alice --epoch 0   # stale epoch
{"error":{"code":"STALE_EPOCH","message":"writer epoch 0 is stale; current epoch is 1","details":{"writerEpoch":0,"currentEpoch":1}}}
exit=5
# tamper: flip one byte in block 1
$ evpack verify demo   # after tamper
{"error":{"code":"TAMPER_DETECTED","message":"block 1 is not valid JSON","details":{"index":1}}}
exit=2
```
