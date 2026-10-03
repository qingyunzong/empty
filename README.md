# auditlog

多租户审计追加日志：配额与公平调度、崩溃点恢复、哈希链证书。Node.js 22，仅用标准库，测试使用 `node:test`。

## 运行

```sh
node --test                 # 全部测试（6 个文件，32 个子测试）
node bin/auditlog.js append --dir /tmp/log <<<'{"tenant":"acme","data":{"cost":12}}'
node bin/auditlog.js recover --dir /tmp/log
node bin/auditlog.js verify --dir /tmp/log
```

- 输入：JSONL（每行一个事件，必须含字符串字段 `tenant`；可选 `seq` 用于客户端定序）。
- 输出：JSON，含 `stats`、`root`（最近一致页的 SHA-256，空日志为 `sha256("")`）、`violations`。
- 退出码：`0` 正常；`2` QUOTA；`3` CORRUPT；`4` SEQ_GAP；`5` READONLY；`1` 其他。

## 磁盘格式与提交协议

日志是单个 `events.log`，由固定大小页（默认 4096 字节，页头自描述）组成，每页后跟 48 字节提交记录：

```
页头 72B: magic | pageSize | version | pageIndex | firstSeq | eventCount | payloadLen | prevHash
负载:     JSONL 事件 + 零填充，末尾 32B 为 payloadHash = sha256(payload)
提交记录: magic | pageIndex | pageHash = sha256(整页)
```

- **哈希链**：页 N 的 `prevHash` = 页 N-1 的 `pageHash`（创世为 32 字节零）；`root` 即最后一致页的 `pageHash`，构成追加日志的哈希链证书。
- **提交点**：页 + 提交记录一次写入后 `fsync`，fsync 即提交点。
  - append 成功后、fsync 前崩溃 → 提交记录缺失/撕裂 → 该页视为未提交，恢复时截断。
  - fsync 后崩溃 → 页与提交记录完整 → 恢复时重放可见。

## 恢复（确定性）

`recover`（可写打开时自动执行）顺序扫描，逐页验证 magic、页索引、`prevHash` 链、`payloadHash`、事件计数与 seq 连续性、提交记录；在第一个不一致处停止：

- 索引（lastSeq、每租户字节数、root）重建到最近一致页；
- 之后的全部字节（未提交页、撕裂页、孤儿页）截断，移入 `quarantine.bin`，并向 `quarantine.jsonl` 追加证明：`{offset, length, sha256, headPageIndex, headHash, reason}`；
- 同一状态恢复两次结果完全相同（第二次为空操作）。

`verify` 只读，不修改文件；任何篡改（负载、提交记录、链节、尾随字节）都以 `CORRUPT`/`SEQ_GAP` 拒绝。

## 配额与公平调度

- **速率配额**：每租户令牌桶（容量 = `ratePerSec`，即 1 秒突发），虚拟时钟仅在所有积压租户都耗尽令牌时推进，调度完全确定。
- **磁盘配额**：每租户硬字节上限（按序列化后事件行精确计字节，重启后由扫描重建）；超限事件以 `QUOTA` 违规拒绝，硬配额绝不突破。
- **aging 防饥饿**：租户得分 = `basePriority + agingRate × 距上次被服务的轮数`。等待单调提升权重，缓冲区有界 ⇒ 饥饿有界：积压租户在 `ceil((maxPriority − 其优先级) / agingRate) + 1` 轮内必被服务；硬配额不受 aging 影响。

CLI 参数：`--rate T=N`（每秒事件数）、`--disk T=BYTES`、`--priority T=N`、`--capacity N`（缓冲事件数）、`--aging-rate N`、`--page-size N`。

## 错误码

| 码 | 含义 |
|---|---|
| `QUOTA` | 速率/磁盘配额拒绝，或事件超过页容量 |
| `CORRUPT` | 哈希链、提交记录、结构校验失败，或输入行非法 |
| `SEQ_GAP` | 事件 seq 不连续（客户端指定 seq 或链内检查） |
| `READONLY` | 对只读日志（`READONLY` 标记文件或 EACCES/EROFS）执行写操作 |

## 测试（`node --test`，32 个子测试，全部通过）

- `test/page.test.js`（5）：页编解码往返、各类篡改拒绝、提交记录、链链接。
- `test/scheduler.test.js`（6）：aging 饥饿有界（低优先级租户 ≤52 轮内被服务，对照无 aging 时垫底）、同优先级公平交替、磁盘硬配额、速率令牌桶硬界、有界缓冲。
- `test/recover.test.js`（8）：fsync 后崩溃重放可见；fsync 前崩溃该页截断；撕裂页截断；孤儿页 quarantine 证明；恢复确定性；索引重建后续写 seq 连续；append 中途崩溃注入；空日志。
- `test/verify.test.js`（6）：正常日志通过；篡改负载/提交记录/链节均被拒；verify 不改文件；未提交尾随字节被拒。
- `test/crosscheck.test.js`（1）：300 组随机试验，每组 1–10 个操作（批量 append + 指定 fsync 点崩溃 ± 撕裂尾），恢复结果与朴素重放器（`test-helpers/naive.js`）逐事件对照，且 seq 连续、恢复后 verify 通过。
- `test/cli.test.js`（6）：append/verify 的 stats/root/violations；篡改退出码 3；recover 截断并写 quarantine 证明；READONLY 退出码 5；SEQ_GAP；磁盘硬配额。

注：测试环境禁止嵌套 spawn，CLI 测试通过 `src/cli.js` 导出的 `runCli(argv, io)` 在进程内注入 I/O 完成；`bin/auditlog.js` 是其薄封装。
