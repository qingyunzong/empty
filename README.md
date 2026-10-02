# SMT Frame Gateway

贴片机二进制检测帧网关：拼帧、去重、生成可验证质量证书。Node.js 22，仅标准库，单机离线。

## 帧格式

```
magic(2, BE 0xAA55) len(2, LE) type(1) board(2, LE) payload(len) crc32(4, LE)
```

- `crc32`：IEEE 802.3，覆盖 `len..payload`（不含 magic 与自身）。
- `DATA (0x01)` payload：`session(2, LE) offset(4, LE) chunk`，可乱序、可重传（按 offset 去重）。
- `END (0x02)` payload：`session(2, LE)`，提交当前 board 并出证。
- `ABORT (0x03)` payload：`session(2, LE) reason(utf8, 可选)`，丢弃当前 board 数据并记录原因。

## 语义

- **crc 错**：记 `bad_crc` 到 frames.log，丢弃该帧，不终止。
- **结构错**（magic 错 / 未知 type / len 非法）：exit 2。流尾半帧不算错，等待后续字节（支持重启续传）。
- **缺片超时**：静止超过 `--timeout` ms 且存在空洞时，向 frames.log 写 `retransmit_request missing_offsets=...`。时钟可注入（`ManualClock`，支持 `pause()/resume()`）。
- **ABORT**：已 END 的 board 收到 ABORT 直接忽略；ABORT 后同 board 新会话 session 必须递增，否则冲突 exit 6。
- **冲突**（同 session 重开 / 活动会话中混入其他 session）：exit 6，已有证书保留。

## 证书（certs.json）

每条证书：`{ board, session, status, merkleRoot, bytesReceived, discardReason }`。

- Merkle 叶 = 装配后数据的定长 1024 字节块的 sha256，故根与切分方式无关，乱序/重传/任意切分均与一次性拼装参考一致。
- `bytesReceived` = 去重装配后的字节数；`discardReason` 仅 aborted 证书非空。
- CLI 重启时加载已有 certs.json，已完成证书不被污染，且其 session 仍作为冲突基线。

## 使用

```sh
node cli.js --stream s.bin --out certs.json [--log frames.log] [--timeout ms]
node --test
```

退出码：`0` 正常，`2` 结构错，`6` 会话冲突，`64` 参数错。

## 实测结果

- `node --test`：9/9 通过（含 4 条验收：乱序重传根一致、半帧重启不污染、同 session 冲突 exit 6 保留旧证、随机切分 50 轮对照枚举 offset 根一致）。
- 端到端 demo（乱序+重传+ABORT 混合流）：exit 0，board 1 committed 根 `f5cca791…c07893` 与一次性参考一致，board 2 aborted 原因 `nozzle jam`。
