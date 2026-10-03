# plc-segment-store

PLC 事件分段落盘存储 + 共现/短语查询。Node.js 22、仅标准库、`node:test`、单机离线。

## 数据布局

```
<dir>/
  manifest.json        # 原子写（tmp + fsync + rename），指向最近一致状态
  manifest.bak         # 上一份 manifest 副本，manifest 损坏时回退
  audit.log            # recover 动作审计（JSONL）
  segments/
    seg-000001.seg     # 段文件：active 可增量追加，frozen 可压缩合并
```

段格式：`magic "PLCS" | version | state(0=active,1=frozen) | headerJson`，随后是记录流。
每条记录：`len varint | payload | crc32(payload)`。payload 两类：

- **DICT**：字典项（事件码 / 设备码字符串，每段只存一次 —— 字典压缩）
- **EVENT**：`seq uvarint | tsDelta zigzag-varint | codeIdx | deviceIdx`（时间戳 delta+varint）

段内事件位置稳定，支持短语序列查询（如 `[ALARM, ACK, RESET]` 连续匹配）。

## 语义

- **ingest**：按 `seq` 幂等去重（同 seq 同 payload → dedup；同 seq 不同 payload → `E_SEQ`）。
  追加写活动段后 `fsync`。
- **freeze**：活动段翻转为 frozen（改状态字节 + fsync + manifest 原子更新）。
- **deleteCode（库 API）**：仅写墓碑到 manifest；查询立即逻辑过滤，`compact` 时物理清除。
- **compact**：合并全部 frozen 段、物理清除墓碑事件、按 seq 重排并重建字典；
  新段先写 tmp + fsync + rename，再原子换 manifest，最后删旧段。
- **query**：`--device D --timeout-code C --window 5` 共现（超时码前后 5 条内的设备码命中）；
  `--phrase ALARM,ACK,RESET` 短语序列。
- **recover**：回到最近一致 manifest——manifest 损坏回退 `.bak`；清理 tmp 与孤儿段
  （合并未提交的产物）；截断半写记录（长度不全 / CRC 不符）并写入 `audit.log`；
  结果对同一文件系统状态确定。

故障注入点（`Store` 构造的 `hooks`）：`afterAppendBeforeFsync`（append 后未 fsync）、
`beforeManifestRename`（写 manifest 中途）、`beforeCompactManifestSwap`（合并替换段前）。

## 错误码

- `E_IO`：目录/段缺失、manifest 损坏（提示 recover）、文件系统错误
- `E_SEQ`：非法 seq（负数/非整数）、同 seq 不同 payload 冲突
- `E_RANGE`：非法 ts/window/phrase/参数

## CLI

```
node cli.js ingest  <dir> [--event '{"seq":1,"ts":1000,"code":"ALARM","device":"D1"}']... [--file x.jsonl]
node cli.js freeze  <dir>
node cli.js compact <dir>
node cli.js query   <dir> (--device D --timeout-code C [--window 5] | --phrase ALARM,ACK,RESET)
node cli.js recover <dir>
```

## 测试结果（真实运行，2026-10-03，node v22.22.1）

`node --test`：

```
ok 1 - test/acceptance.test.js
ok 2 - test/varint.test.js
# tests 2
# pass 2
# fail 0
```

逐用例（`node --test-reporter=spec test/acceptance.test.js test/varint.test.js`）：

```
✔ acceptance 1: random events match brute-force window enumeration   # 3000 随机事件 × 4 设备 × 窗口{0,1,5} + 短语，与枚举对照一致
✔ acceptance 2a: crash after append before fsync -> torn tail dropped and audited
✔ acceptance 2b: crash mid-manifest-write -> recover to last consistent manifest
✔ acceptance 2c: crash before merge replaces segments -> orphan rolled back
✔ acceptance 3: delete old code + compact -> neighbors no longer match
✔ acceptance 4: repeated ingest of the same seq is idempotent
✔ error codes: E_IO, E_SEQ, E_RANGE
✔ uvarint roundtrip
✔ uvarint detects truncation
✔ zigzag roundtrip incl. negatives
✔ crc32 known vector
tests 11, pass 11, fail 0
```
