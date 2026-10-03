# obsnet-replica — 观测台站网副本管理

Node.js 22、仅标准库。实现成员变更（epoch 成员表）、法定读写（向量时钟）、
tombstone 审计与反熵修复，附 JSONL CLI。

## 结构

- `src/cluster.js` — 核心库：`Cluster` / `Node` / 向量时钟工具，错误 `ClusterError`
- `src/cli.js` — JSONL 命令行接口（stdin 命令 → stdout JSON）
- `test/cluster.test.js` — 4 项验收测试（node:test）
- `test/cli.test.js` — CLI 端到端测试（含三类错误）

## 核心语义

- **成员表按 epoch 递增**：每次有效 `join`/`leave` 产生新 epoch，完整历史存于
  `membershipLog`（可审计）。重复 `join` 幂等：不产新 epoch，返回 `idempotent: true`。
- **写**：需当前 epoch 活跃成员多数派（`⌊n/2⌋+1`）确认；未达多数派则回滚已投递
  副本并抛 `QUORUM_FAIL`。指定旧 epoch 抛 `EPOCH_MISMATCH`；非成员/tombstone
  节点发起写抛 `NOT_MEMBER`。
- **读**：从当前 epoch 多数派收集，返回法定证书
  `{epoch, signers: [节点id], vector: 合并向量时钟}`。
- **leave → tombstone**：节点不再计票、不可写，但数据保留在 `nodes` 中供审计
  与反熵；重新 `join` 可恢复投票权。
- **repair（反熵）**：按向量缺口（缺失的 `writer:counter` entry）从对等节点补齐，
  按因果序（向量分量和升序）安装；只增集合 + 幂等 `install`，不改变已确认因果序。
  并发写按 `(writer, counter)` 字典序确定性裁决，保证 repair 与暴力全量拷贝的
  最终可见值一致。
- **分区模拟**：`isolate([ids])` 丢弃发往这些节点的消息，`heal()` 恢复；
  多数派侧可继续读写。

## CLI 用法

```sh
printf '%s\n' \
  '{"op":"join","node":"n1"}' \
  '{"op":"join","node":"n2"}' \
  '{"op":"join","node":"n3"}' \
  '{"op":"write","key":"temp","value":21.5,"node":"n1"}' \
  '{"op":"read","key":"temp"}' \
  '{"op":"leave","node":"n3"}' \
  '{"op":"repair"}' | node src/cli.js
```

每行输出一个 JSON：成功 `{"ok":true,"op":...}`，失败
`{"ok":false,"error":"NOT_MEMBER"|"EPOCH_MISMATCH"|"QUORUM_FAIL"}`。
辅助命令：`isolate` / `heal` / `members`。

## 测试

```sh
node --test
```

真实运行结果（Node v22.22.1，2026-10-03）：

```
✔ test/cli.test.js (2547.645666ms)
✔ test/cluster.test.js (1710.104376ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
ℹ duration_ms 2731.743259
```

覆盖验收：1) 3→5→3 扩缩容后旧 epoch 写被拒（EPOCH_MISMATCH）、tombstone 写被拒
（NOT_MEMBER）；2) 5 节点隔离 2 个少数派后多数派侧可写可读，隔离至不足多数派时
QUORUM_FAIL，heal 后全员恢复；3) 60 次随机分区+随机写后 repair 收敛，与暴力全量
拷贝可见值逐节点一致，且 repair 幂等；4) 重复 join 不产新 epoch。
