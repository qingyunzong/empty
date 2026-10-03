# plc-segstore

PLC 事件段式存储库与 CLI。Node.js 22、仅标准库、`node:test`、单机离线。

## 存储设计

- **段文件** `seg-NNNNNN.plc`：头 = `PLCS` 魔数 + 版本 + `baseTs`(zigzag varint)；
  记录帧 = `varint 帧长 | CRC32(4B) | payload`，payload = `seq varint | tsDelta zigzag varint | codeId varint`。
  时间戳按段内 delta 编码，事件码经 manifest 字典压缩为 codeId，记录按序保留位置以支持短语序列查询。
- **manifest.json**：唯一事实源。记录每段已提交字节数 `bytes`、`count`、`nextSeq`、字典、墓碑。
  每次写入走 `tmp -> fsync -> rename -> 目录 fsync` 原子替换。
- **活动段**增量追加（writeSync -> fsync -> 提交 manifest）；**冻结段**由 `compact` 合并重写，
  墓碑码在合并时物理清除；删除仅打墓碑，查询即时过滤。
- **故障点**（`PLC_FAULT` 环境变量注入）：`afterAppend`（append 后未 fsync）、
  `midManifest`（manifest tmp 写一半）、`beforeMergeSwap`（合并段已落盘、未换 manifest）。
- **recover**：回到最近一致 manifest —— 删除残留 tmp、删除孤儿段、按 manifest `bytes`
  截断活动段半写记录，审计结果打印并追加到 `recover-audit.log`。

## CLI

```
plc --dir <dataDir> ingest --seq N --ts T --code CODE
plc --dir <dataDir> freeze
plc --dir <dataDir> compact
plc --dir <dataDir> delete --code CODE
plc --dir <dataDir> query cooccur --device DEV9 --timeout TIMEOUT [--window 5]
plc --dir <dataDir> query phrase --seq ALARM,ACK,RESET
plc --dir <dataDir> recover
```

错误码：`E_IO`（IO/损坏）、`E_SEQ`（序号空洞）、`E_RANGE`（参数越界），
JSON 输出到 stderr，退出码 1；模拟崩溃（`E_FAULT`）退出码 2。
重复 ingest 同一 seq 幂等返回 `{"dedup":true,...}`。

## 验收测试（真实运行结果）

`node --test`，Node v22.22.1，2026-10-03 运行：

```
ok 1 - test/cooccur.test.js      # 随机事件 vs 枚举窗口暴力对照（共现+短语+时间戳往返）
ok 2 - test/delete.test.js       # 删除旧码 + compact 后近邻不再命中，字节物理清除
ok 3 - test/fault.test.js        # 三故障点注入后 recover 结果确定（各跑两遍逐字节一致）
ok 4 - test/helpers.js
ok 5 - test/idempotent.test.js   # 同序号重复 ingest 幂等，空洞报 E_SEQ
ok 6 - test/varint.test.js       # varint/zigzag/CRC32/段编解码单测
# tests 6
# pass 6
# fail 0
# duration_ms 9062.356843
```

注：沙箱禁止子进程，CLI 级测试通过注入式 `run(argv, io)` 在进程内驱动，
故障注入语义（部分写盘 + 崩溃）与真实崩溃一致，因为所有持久化都是同步写。
