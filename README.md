# alert-store

离线设备告警存储与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 存储设计

- **段（segment）**：告警以 JSON 记录 `[u32 长度][payload]` 紧凑写入定长 chunk，
  记录不跨 chunk，剩余空间补零。段文件 = 24 字节头（magic、段 id、chunk 大小/数量、
  记录数）+ 数据区 + 4 字节 CRC32（IEEE）尾。任何一字节损坏在校验时产生 `E_CRC`。
- **清单（manifest）**：`manifest.json` 列出当前可读段。环形覆盖时**先写新段文件**
  （tmp + fsync + rename），再原子 rename 新清单。崩溃发生在 rename 前：旧清单不变，
  旧段全部可读，新段成为孤儿文件，下次打开时清理；rename 后：新段生效，最旧段被驱逐。
- **索引（index.json）**：按设备保存 minSeq/maxSeq 及每段的文件偏移（设备首条记录
  在段文件中的绝对偏移），随 `close()` 原子落盘。
- **游标重放**：`replay(cursor)` 中 cursor 为 `{设备: 已确认连续序号}`。返回按
  严重级别（critical > error > warning > info > debug）、设备 id、序号排序的告警，
  以及新的游标证书（各设备已连续前缀的高水位）。
- **幂等与空洞**：重复序号幂等忽略并计数（`deduped`）；检测到序号空洞时返回
  `E_GAP`，只保留已连续前缀，绝不跳洞假装完整；迟到的补齐记录可以愈合空洞。

## CLI

```sh
node src/cli.js append --dir D --device dev-1 --seq 1 --severity critical --message "temp high"
node src/cli.js replay --dir D [--cursor '{"dev-1":3}']
node src/cli.js verify --dir D
node src/cli.js index  --dir D
# 可调: --chunk-size N --segment-chunks N --max-segments N
```

退出码：`0` 正常；`1` 用法错误；`2` 其他错误；`3` = `E_GAP`（已连续前缀仍输出到
stdout）；`4` = `E_CRC`。

## 测试

```sh
node --test
```

覆盖：手工折叠小序号集合 vs 重放结果、丢包 `E_GAP`、重复发送去重计数、
段内一字节损坏 `E_CRC`、覆盖崩溃前后游标证书指向的已确认前缀不变、CLI 退出码。
