# walstore — WAL 为核心的可审计测量存储

计量院场景：每一次值变更都可审计、可重放、可证伪。所有变更以逻辑日志（WAL）
追加，二级索引仅作加速，正确性一律以 WAL 重放为准。

- 运行时：Node.js 22，仅标准库（`fs`/`path`/`util`/`assert`/`node:test`），单机离线
- 测试：`node --test`

## 数据布局

```
<data-dir>/
  wal.log            # 追加式逻辑日志（唯一事实来源）
  index.json         # 按设备ID的二级索引（派生物，可随时重建）
  checkpoints/<txn>.json   # 检查点：某事务序号时刻的完整状态快照
```

### 日志记录格式

每条记录：`[u32le payloadLength][u32le crc32(payload)][payload]`，
payload 为 JSON：`{txn, op, key, deviceId, oldValue, newValue}`。

- `txn`：单调递增事务序号（每次 apply 一个事务）
- `op`：`set` / `del`
- `oldValue`/`newValue`：变更前后值（`oldValue` 使日志可证伪——重放时逐条
  校验日志声明的旧值与重放状态一致，不一致报 `OLD_VALUE_MISMATCH`）
- CRC-32（IEEE）覆盖 payload；校验和失败精确定位到记录起始字节偏移

## CLI

```
node src/cli.js [--data DIR] <command>

apply --key K --device D --value V   # set（--value 按 JSON 解析，失败按字符串）
apply --key K --delete               # del
    [--inject after-write|after-fsync]   # 在指定故障注入点模拟崩溃（退出码 75）
replay --to N                        # 重建事务 N 时刻的完整状态（N=0 为空态）
audit                                # 全量重放 WAL，对比 index.json，报告分歧
checkpoint                           # 以当前状态写检查点
inject truncate --offset N           # 物理截断 wal.log（模拟撕裂写/掉电）
inject corrupt-byte --offset N       # 翻转指定偏移字节（模拟位腐烂）
```

退出码：`0` 成功；`1` 用法/IO 错误；`2` `NO_SUCH_TXN`；`3` `CHECKSUM_MISMATCH`；
`4` `AUDIT_DIVERGENCE`（audit 发现分歧）；`75` 注入崩溃。

## 错误约定

- **NO_SUCH_TXN**：`replay --to N` 超过最后一条日志事务号；stderr 输出
  `ERROR NO_SUCH_TXN: ...`，退出码 2。
- **CHECKSUM_MISMATCH**：校验和/ framing 失败，报出**字节偏移**并停止：
  `ERROR CHECKSUM_MISMATCH: WAL corruption (checksum) at byte offset 1234`，退出码 3。

## 恢复模型

- **只读路径**（`replay`/`audit`）绝不修改日志。目标事务在损坏点之前可正常
  重放；越过损坏点则报 `CHECKSUM_MISMATCH` 并指出偏移。
- **写路径**（`apply`/`checkpoint`）打开时执行恢复：扫描到第一条不可用记录
  （撕裂写/校验和失败），在该偏移处**截断**，截断点之前全部可重放，之后干净
  丢弃，随后事务号从截断点继续递增。恢复事件打印到 stderr（`RECOVERY: ...`）。
- 故障注入点：`after-write`（写系统调用后、fsync 前）、`after-fsync`
  （fsync 后、内存状态提交前），用于验证两种崩溃窗口下恢复一致性。

## 重放一致性

- `replay --to N` 选取 ≤ N 的最新检查点，再沿 WAL 前滚到 N，逐条校验
  `oldValue` 链；无检查点则从空态全量重放。
- `audit` 无视检查点与索引，从空态全量重放重建期望索引，与 `index.json`
  逐项 diff，分歧分为 `missing-in-index` / `stale-in-index` 两类报告。
  索引只是加速器：人为破坏索引后 audit 报分歧，重放结果仍然正确。

## 测试结果（真实运行记录）

环境：Node v22.22.1，Linux x86_64。命令：`node --test`

```
ok 1 - test/audit.test.js
ok 2 - test/cli.test.js
ok 3 - test/crash.test.js
ok 4 - test/random.test.js
ok 5 - test/replay.test.js
ok 6 - test/wal.test.js
1..6
# tests 6
# pass 6
# fail 0
# duration_ms 49993.221298
```

覆盖的验收场景：

1. **2000 次变更重放一致性**（`test/replay.test.js`）：2000 次随机变更
   （含 txn=1000 处检查点），`replay --to 1234` 与当时参考模型快照逐键相等；
   `replay --to 2000` 与实时路径状态逐键相等；`replay --to 2001` 返回
   `NO_SUCH_TXN`。
2. **索引破坏审计**（`test/audit.test.js`）：人为删除一个设备条目并注入
   幻影键后，audit 报告 `missing-in-index`/`stale-in-index` 分歧，同时
   WAL 重放结果与参考模型一致；按重放结果修复索引后 audit 恢复通过。
3. **日志中段截断崩溃**（`test/crash.test.js`、`test/cli.test.js`）：
   在第 61 条记录中部截断，重启后 txn≤60 全部可重放；恢复截断撕裂尾部后
   `checkpoint` 继续、新事务从 61 续号；`after-write`/`after-fsync` 注入
   崩溃后恢复一致；中途字节损坏时 `replay`/`audit` 报 `CHECKSUM_MISMATCH`
   并指出偏移。
4. **随机序列对照参考模型**（`test/random.test.js`）：3 个确定性种子、
   每个 600 次随机 set/del，每 50 步校验实时状态并随机重放历史事务，
   中途重启与检查点，最终 audit 通过。
