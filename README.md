# weldgw — 焊装车间 PLC 网关（离线工单接入）

Node.js 22、仅标准库、`node:test`。把 PLC 上报的字节流（可粘连、半帧、重复、乱序）
分帧、排序、去重后接入离线工单台账，输出 NDJSON 事件与证书。单机离线，无网络依赖。

## 帧格式（大端）

| 字段   | 字节 | 说明 |
|--------|------|------|
| magic  | 2    | 固定 `0x5747`（"WG"） |
| len    | 2    | payload 字节数（≤ 4096） |
| type   | 1    | `0x01` WELD_START / `0x02` WELD_END / `0x03` UNDO |
| seq    | 4    | 发送序号，从 0 递增 |
| ack    | 4    | 对端确认号（透传保留） |
| payload| len  | UTF-8 JSON 对象 |
| crc16  | 2    | CRC-16/CCITT-FALSE，覆盖 magic..payload |

payload 约定：START/END 需 `orderId`（可带 `weldId`）；UNDO 需 `orderId` + `targetSeq`。

## 语义

- **分帧器**（`lib/framer.js`）：任意切块喂入，粘连帧依次拆出，半帧缓存待续；
  坏 magic / 长度超限 / CRC 错 / 未知 type / 坏 JSON 一律 `ParseError(code, offset)`。
- **排序与重传**（`lib/gateway.js`）：按 seq 保序交付；乱序帧进重排缓冲并触发
  `RETRANSMIT_REQUEST`；虚拟时钟（`lib/clock.js`，离线确定性）驱动超时重试，
  超过 `--retries` 报 `SEQ_GAP_TIMEOUT`。
- **去重缓存**：已交付或已缓冲的 seq 再次到达记 `DUPLICATE_DROPPED`，绝不重复入账。
- **UNDO 规则**（`lib/ledger.js`，先校验后改状态，失败则状态不变）：
  只能撤销**同一工单**、**最近未闭环（未被撤销）**、**未被后续 START 覆盖**的 WELD_END；
  成功时生成反向事件 `WELD_END_REVERSED`，原 `WELD_END` 事件保留在日志中。
  违例码：`CROSS_ORDER_UNDO` / `UNDO_ALREADY_CLOSED` / `UNDO_COVERED_BY_START` /
  `UNDO_TARGET_NOT_FOUND` / `INVALID_PAYLOAD`。
- **证书**：输出最后一行 `certificate`，含帧数、交付数、去重数、重传数与事件流
  FNV-1a 摘要 `digest`，用于与暴力重放对账。

## 用法

```bash
node cli.js --in trace.hex --clock 0 --out out.ndjson   # 文件输入
cat trace.hex | node cli.js                             # stdin 输入，stdout 输出
```

- `--in` 十六进制流文件（缺省读 stdin，允许空白/换行）
- `--out` NDJSON 输出文件（缺省写 stdout）
- `--clock 0` 选择确定性虚拟时钟（离线默认）
- `--timeout N` 重传超时（虚拟 tick，默认 2）；`--retries N` 最大重传次数（默认 3）

退出码：`0` 成功；`2` 解析错误（输出 `{"error":{"code","offset"}}`）；
`3` 协议违例（输出 `{"error":{"code",...}}`，之前的事件与证书保留）。

## 真实运行记录

`node examples/build-trace.js` 生成 `examples/trace.hex`（6 帧：粘连 + 乱序缺 seq 1 +
重传补齐 + 1 个重复 + 1 次合法 UNDO），然后：

```
$ node cli.js --in examples/trace.hex --clock 0 --out examples/out.ndjson   # exit=0
{"event":"WELD_START","seq":0,"orderId":"ORD-1001","weldId":"W-01"}
{"event":"RETRANSMIT_REQUEST","from":1,"to":1,"attempt":1,"tick":2}
{"event":"WELD_END","seq":1,"orderId":"ORD-1001","weldId":"W-01"}
{"event":"WELD_START","seq":2,"orderId":"ORD-1002","weldId":"W-02"}
{"event":"DUPLICATE_DROPPED","seq":1}
{"event":"WELD_END","seq":3,"orderId":"ORD-1002","weldId":"W-02"}
{"event":"WELD_END_REVERSED","seq":4,"orderId":"ORD-1002","targetSeq":3}
{"certificate":{"ok":true,"frames":6,"delivered":5,"duplicates":1,"reordered":1,"retransmitRequests":1,"events":5,"digest":"8a46f17e"}}
```

解析错误（第二帧 CRC 被翻转），exit=2：

```
{"event":"WELD_START","seq":0,"orderId":"A","weldId":null}
{"error":{"code":"CRC_MISMATCH","offset":58}}
```

协议违例（跨工单 UNDO），exit=3，状态不变：

```
{"event":"WELD_END","seq":0,"orderId":"A","weldId":"w0"}
{"certificate":{"ok":false,"frames":2,"delivered":1,"duplicates":0,"reordered":0,"retransmitRequests":0,"events":1,"digest":"b8000bee"}}
{"error":{"code":"CROSS_ORDER_UNDO","seq":1,"message":"frame 1: end 0 belongs to order A, not B"}}
```

## 测试

```bash
node --test
```

真实结果（Node v22.22.1）：6 个测试文件、25 个用例全部通过
（`# tests 6 / # pass 6 / # fail 0`，约 3.5s）。覆盖验收点：

1. `test/gateway.test.js` / `test/framer.test.js`：粘连 + 逐字节半帧恢复后，
   事件顺序等于参考枚举；
2. 重复 seq 与超时重传只入账一次（证书 `delivered`/`duplicates` 对账）；
3. 跨工单 UNDO、已闭环 UNDO、被后续 START 覆盖的 UNDO 均失败且台账状态不变；
4. `test/property.test.js`：40 组种子随机小流（乱序 + 重复 + 随机切块）与
   暴力重放的参考枚举逐事件一致，证书 digest 相同。

## 结构

```
cli.js            CLI 与可测试的 execute() 核心
lib/frame.js      帧编解码、常量、ParseError
lib/framer.js     增量分帧器（粘连/半帧）
lib/gateway.js    保序、去重、重传、证书
lib/ledger.js     工单台账与 UNDO 规则
lib/clock.js      虚拟时钟
lib/crc16.js      CRC-16/CCITT-FALSE
lib/hex.js        十六进制流解码
examples/         trace 生成脚本与样例
test/             node:test 测试
```
