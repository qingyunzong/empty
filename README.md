# audit-trail — 审计追踪终端库与 CLI

Node.js 22，仅标准库，单机离线。操作经二进制帧提交，追加到只增不减的哈希链日志；
支持重传去重、乱序缓冲、分帧解析、虚拟时钟租约、可验证 checkpoint、事务撤销与崩溃恢复。

## 布局

- `cli.js` — CLI 入口（`run()` 可注入输出，便于测试）
- `src/frame.js` — 二进制帧编解码 + 流式分帧解析器（CRC32 校验）
- `src/chain.js` — append-only 日志、哈希链、checkpoint 签发/验证、崩溃恢复
- `src/engine.js` — 协议引擎：去重、乱序缓冲、租约判定、线性化
- `src/crc32.js` / `src/canon.js` — CRC32(IEEE) 与规范化 JSON
- `test/` — node:test 验收测试；`examples/gen-frames.js` — 生成演示帧

## 帧格式（大端）

```
magic "AT" (2) | version u8 | type u8 (1=OP) | opId (16B)
actorLen u8 + actor | cmdLen u8 + cmd | argsLen u16 + args(JSON)
prevHash (32B) | seq u64 | leaseUntil u64 | crc32 u32
```

帧可任意分片到达（`FrameParser` 流式重组）；CRC 不匹配即帧错。

## 协议语义

- **重传/去重**：按 `opId` 去重，重放返回缓存的相同 `ack`，不产生新 entry。
- **乱序/分帧**：`seq` 大于下一期望值的帧进入缓冲区；前驱到达后按 `prevHash` 链上链。
- **虚拟时钟租约**：每处理一帧时钟 +1；`leaseUntil < clock` 的迟到写被拒绝（exit 3），
  证据（含原始帧哈希）写入 `evidence.json`，不进入日志。
- **线性化**：多 actor 并发提交按 `seq`（租约有效者）排序；任意到达交错产生相同 root。
- **撤销**：`cmd:"undo", args:{target:opId}` 追加 inverse entry（日志从不截断），
  entry 内含 `proof:{targetHash, targetSeq, preStateHash}` 证明被撤销 entry 的前置状态；
  撤销的撤销即逆的逆，恢复原操作。

## 崩溃点与恢复

三个崩溃点：帧解析后（无持久化，安全）、日志落盘后（index 过期，恢复时以日志为准重建）、
索引更新后（一致）。启动时总是从 `audit.log` 重放重建索引与状态，逐条校验哈希链、
stateHash 与 undo proof；链断裂 exit 5。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 帧错误（magic/version/CRC/截断） |
| 3 | 租约过期拒绝 |
| 5 | 链断裂 / checkpoint 验证失败 |

## 真实运行记录

```console
$ node examples/gen-frames.js
wrote 576 bytes, 5 frames
```

`frames.bin` 含 5 帧：op1、op1 重传、op3（乱序）、op2、op4（租约已过期）。

```console
$ AUDIT_DIR=demo/data node cli.js examples/frames.bin
{"opId":"aaaa…aaaa","status":"applied","seq":1,"hash":"e5839ead…","ack":"4abdbf9e…"}
{"opId":"aaaa…aaaa","status":"duplicate","seq":1,"hash":"e5839ead…","ack":"4abdbf9e…","dedup":true}
{"opId":"cccc…cccc","status":"buffered","reason":"out-of-order: waiting for seq 2"}
{"opId":"bbbb…bbbb","status":"applied","seq":2,"hash":"a9870231…","ack":"0a991497…"}
{"opId":"cccc…cccc","status":"applied","seq":3,"hash":"0034002a…","ack":"87c1e6f5…"}   # 缓冲帧被 drain
{"opId":"dddd…dddd","status":"rejected","reason":"lease-expired: leaseUntil=1 < clock=4","exitCode":3,"evidence":"eb128ff6…"}
{"root":"…","count":3,"rejected":1,"checkpoint":{"count":3,"root":"…","stateHash":"…","sig":"…"}}
$ echo $?
3
```

（hash 截短显示；undo 帧 op3 撤销了 op2 的 `inc balance -30`，state 回到 `{balance:100}`。）

```console
$ AUDIT_DIR=demo/data node cli.js verify demo/data/checkpoint.json
{"ok":true,"count":3,"root":"0034002a6fcfee9f3dfa906d2d788d6187b3b56d726a6c4e87068fd798b44bee"}
$ echo $?
0
```

篡改日志后验证（真实输出）：

```console
$ sed -i 's/"value":100/"value":999/' demo/data/audit.log
$ AUDIT_DIR=demo/data node cli.js verify demo/data/checkpoint.json
error: chain break: hash mismatch at seq 1
$ echo $?
5
```

坏帧与篡改 checkpoint：

```console
$ AUDIT_DIR=demo/data node cli.js demo/bad.bin
error: bad magic        # exit 2
$ node cli.js verify forged.json   # count 被改为 99
error: verify failed: checkpoint signature invalid   # exit 5
```

## 测试

```console
$ node --test
# tests 3
# pass 3
# fail 0
```

验收覆盖（`test/acceptance.test.js`、`test/cli.test.js`）：

1. 同 opId 重放 → `duplicate`，ack 相同，日志不增长；
2. 乱序 prevHash 暂存 → 前驱到达后按序上链，root 与串行参考一致；
3. 撤销后再撤销 → 追加 inverse entry，状态恢复，日志只增不减；
4. 三故障点（解析后/落盘后/索引后）注入崩溃 → 恢复后索引与日志一致；
5. 8 个操作（3 actor：3+3+2）枚举全部 560 种保序交错 → 与参考串行器 root/state 完全一致；
   另有 CRC 错 exit 2、租约过期 exit 3 + 证据保留、链断裂 exit 5、分帧解析（1/3/7/64/全长切片）。
