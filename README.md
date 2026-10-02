# reassembler — 文件传输网关分片重组器

纯 Python 3.11 标准库实现。处理互相重叠、乱序、重复的分片；坏分片
永远不会污染已验证的数据。按 `(transfer_id, epoch)` 管理重组状态。

## 设计

- **分片** (`reassembler/fragments.py`)：携带 `offset`、`data`、可选
  `total_length` / `total_hash`（sha256），`digest` 为内容哈希。
- **区间树** (`reassembler/intervals.py`)：有序不相交区间集，合并相邻/
  重叠区间，逐区间保存来源证据（fragment id），提供覆盖、缺口查询。
- **传输状态** (`reassembler/transfer.py`)：
  - 相同内容的重叠被接受；内容不同的重叠**整条拒绝** incoming 分片，
    并报告**最小冲突区间** `[first_diff, last_diff+1)` 与**双方分片 id**。
  - 总长度只能从「未知 → 确定」转换一次；声明不同长度被拒绝，
    必须开新 epoch（`epoch` 不同的分片路由到独立状态）。
  - 声明总长超过内存阈值后切换到**稀疏临时文件**（`SparseFileStorage`，
    `ftruncate` 稀疏分配 + `pwrite/pread`）。
  - **分片撤回**：移除该分片后由剩余分片重建覆盖与存储，产生新缺口。
  - **动态 MTU 重发**：`retransmit_plan(mtu)` 把每个缺口切成 ≤ mtu 的
    请求，mtu 每次调用可不同。
- **网关** (`reassembler/gateway.py`)：
  - 虚拟时钟 `advance_time(now)` 回收闲置超时的未完成传输；回收与
    正在提交的完整文件**互斥**（`committing` 标志 + 网关锁，同刻完成
    优先于超时）。
  - **检查点**：每次状态变更原子写入 `checkpoints/`，恢复时重放分片
    重建状态；重复恢复幂等。
  - **提交日志**：`begin_commit` / `end_commit` / `abort_commit` 追加
    到 `commit.log`（fsync）。恢复时清理无 `end_commit` 的孤儿临时
    文件——恢复后绝不会发布缺洞文件。
  - 完成文件先经**总哈希核验**，再写临时文件 + fsync + `os.replace`
    **原子替换**发布；临时文件被篡改会导致 `hash_mismatch` 并中止。

## CLI

```
python3.11 -m reassembler --workdir DIR [--memory-threshold N] [--timeout S]
```

stdin 每行一个 JSON 命令，stdout 每行一个 JSON 结果：

```json
{"op":"submit","transfer_id":"t","epoch":0,"frag_id":"f1","offset":0,
 "data_b64":"aGVsbG8=","total_length":5,"total_hash":"<sha256hex>"}
{"op":"retract","transfer_id":"t","frag_id":"f1"}
{"op":"retransmit","transfer_id":"t","mtu":512}
{"op":"status","transfer_id":"t"}
{"op":"finalize","transfer_id":"t"}
{"op":"tick","now":100.0}
{"op":"recover"}
```

## 测试

```
python3.11 -m unittest discover -s tests -v
```

- `tests/test_exhaustive.py`：对 `{a,b}` 上长度 ≤ 3 的全部字节串，
  枚举所有连续切分（≤3 段）、所有覆盖性重叠区间子集（≤3 区间）、
  重复分片变体，再枚举全部交付排列；每个用例与独立的逐字节来源
  模型核对，并完成总哈希核验与原子发布。另枚举所有同源长度不同
  内容的分片对 × 全部重叠区间对，验证最小冲突区间与双方分片 id。
- `tests/test_reassembler.py`：重叠冲突、零长文件、尾片先到、超时
  同刻完成、撤回造成新缺口、动态 MTU、稀疏文件、临时文件篡改。
- `tests/test_recovery.py`：检查点恢复、重复恢复幂等、提交中途崩溃
  不发布、已完成提交恢复后保留、损坏检查点拒绝发布。

## 测试结果记录

```
$ python3.11 -m unittest discover -s tests -v
...
Ran 36 tests in 4.264s

OK
```

（穷举用例规模：重组排列 >1000 例，冲突对 >100 例，全部通过。）
