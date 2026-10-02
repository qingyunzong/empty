# RESULTS — 真实测试记录

- 日期: 2026-10-03
- 运行时: Node.js v22.22.1（仅标准库，零依赖）
- 命令: `node --test`（另逐文件 `node <file>` 展开子测试）

## 总览（node --test 实际输出）

```
✔ test/chain.test.js (3384.289532ms)
✔ test/crash.test.js (4147.861888ms)
✔ test/epoch.test.js (3911.546486ms)
✔ test/merkle.test.js (9565.982008ms)
✔ test/sync.test.js (3864.42197ms)
✔ test/tamper.test.js (8682.88545ms)
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10385.134024
```

退出码: 0。6 个测试文件、20 个子测试全部通过。

## 子测试明细（逐文件真实输出）

```
[test/chain.test.js] ok 1 - acceptance 1: hash chain and root match brute-force reference over block files
[test/chain.test.js] ok 2 - add accepts JSONL file input, one block per line
[test/crash.test.js] ok 1 - crash between block write and commit record: no half-committed block
[test/crash.test.js] ok 2 - crash during commit tmp write leaves old commit intact
[test/epoch.test.js] ok 1 - acceptance 4: write from old-epoch member is rejected with STALE_EPOCH (exit 5)
[test/epoch.test.js] ok 2 - old-epoch blocks stay readable after the barrier
[test/epoch.test.js] ok 3 - epoch propagates through sync handshake
[test/merkle.test.js] ok 1 - acceptance 1: random small trees match brute-force Merkle reference
[test/merkle.test.js] ok 2 - acceptance 1: inclusion proofs verify for every index of random trees
[test/merkle.test.js] ok 3 - empty tree has deterministic domain-separated root
[test/sync.test.js] ok 1 - acceptance 3: replicas with different missing sets converge in finite rounds
[test/sync.test.js] ok 2 - sync is idempotent: second run transfers nothing
[test/sync.test.js] ok 3 - sync pulls tail extension and verifies end-to-end
[test/sync.test.js] ok 4 - sync rejects blocks served by a tampering peer
[test/tamper.test.js] ok 1 - acceptance 2: flipping 1 byte is located by verify with exit 2 + stderr JSON
[test/tamper.test.js] ok 2 - tampered block data is detected at the right index
[test/tamper.test.js] ok 3 - missing block exits 3 with MISSING_BLOCK and index
[test/tamper.test.js] ok 4 - invalid inclusion proof exits 4 with INVALID_PROOF
[test/tamper.test.js] ok 5 - valid inclusion proof verifies with exit 0
[test/tamper.test.js] ok 6 - proof for index out of range is rejected
```

## 验收标准对照

| # | 验收标准 | 测试 | 结果 |
|---|---|---|---|
| 1 | 随机小图 vs 暴力重算哈希/Merkle 参考 | `test/merkle.test.js`（200 组随机树 n∈[1,64] 对照独立递归参考；100 组全索引证明往返+负例）、`test/chain.test.js`（12 块链式哈希/根对照独立参考） | PASS |
| 2 | 翻转 1 字节必被 verify 定位 | `test/tamper.test.js`：exit 2，stderr JSON `TAMPER_DETECTED` 且 `index` 精确指向被改块 | PASS |
| 3 | 不同缺失集两副本有限轮 sync 收敛 | `test/sync.test.js`：A 缺内块 {2,5} 且尾部短 2 块、B 缺内块 {3}，≤5 轮收敛（实测 1 轮），收敛后双方 verify=0 且 digest 完全一致；第二轮幂等传输 0 | PASS |
| 4 | 旧成员写入返回 STALE_EPOCH | `test/epoch.test.js`：成员变更 epoch→2 后，epoch-1 副本的新块在 sync 被拒，exit 5，stderr `STALE_EPOCH`；旧 epoch 数据 verify/prove 仍可读 | PASS |

附加：崩溃恢复（`test/crash.test.js`）——块落盘后、提交记录落盘前崩溃只留孤儿块，
digest/verify 不可见半提交块；未 rename 的 commit tmp 文件不影响旧提交记录。

## 退出码契约（测试覆盖）

| exit | code | 触发 |
|---|---|---|
| 0 | — | 成功 |
| 2 | TAMPER_DETECTED | 哈希链断裂 / 块哈希、head、Merkle 根不匹配 |
| 3 | MISSING_BLOCK | 已提交区间内块文件缺失 |
| 4 | INVALID_PROOF | 包含证明无效 |
| 5 | STALE_EPOCH | 旧 epoch 写入被屏障拒绝 |
| 6 | USAGE | 用法错误 |

注：沙箱禁止 spawn 子进程，CLI 测试通过 `src/cli.js` 的进程内入口 `run(argv)`
执行；`bin/evpack.js` 是同一函数的薄封装，exit code 与 stderr JSON 契约一致。
