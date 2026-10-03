# alert-store

离线设备告警存储与 CLI。Node.js 22,仅标准库,测试使用 `node:test`。

## 存储布局

```
<dir>/manifest.json          可读段清单(tmp + rename 原子更新)
<dir>/manifest.json.tmp      暂存清单,崩溃恢复时丢弃
<dir>/segments/seg-NNNN.seg  固定大小分块段
<dir>/index.json             索引快照(close 时物化,打开时从段重建)
```

- 段头 16 字节:magic(4) version(1) count(uint32le) crc32(uint32le,覆盖已用记录区) reserved(3)。
- 记录定长 80 字节:device(16) seq(uint64le) severity(uint8) ts(int64le) message(47)。
- 索引保存设备、最小/最大序号与文件偏移(段名 + 段内偏移)。

## 语义

- 每设备序号单调。`seq == maxSeq+1` 写入;`seq <= maxSeq` 幂等忽略并计去重;
  `seq > maxSeq+1` 抛 `E_GAP`,空洞不跳过的,已连续前缀保持不变。
- 重放按 severity 升序,相同者按设备 id、序号排序;游标(base64url JSON,
  含每设备已确认序号与前缀 CRC32 摘要)支持增量重放与 `verify` 校验。
- 环形覆盖:先完整写入并 fsync 新段,再 tmp + rename 原子替换清单,最后删除被逐出段。
  rename 前崩溃 → 旧清单与旧段仍可读,孤儿段与暂存清单在打开时清理;rename 后新清单生效。
- 打开时校验每段 CRC32,一字节损坏即 `E_CRC`。

## CLI

```
node src/cli.js append --dir D --device ID --seq N [--severity S] [--message M] [--ts MS]
node src/cli.js replay --dir D [--cursor TOKEN]
node src/cli.js verify --dir D --cursor TOKEN
node src/cli.js stats  --dir D
```

退出码:0 成功,2 用法错误,3 `E_GAP`,4 `E_CRC`,5 `E_CURSOR`,1 其他。

## 测试

```
node --test
```
