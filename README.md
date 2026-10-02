# weld-gateway

焊装车间网关：把 PLC 上报的字节流帧接入离线工单系统。Node.js 22，仅标准库，
测试使用 `node:test`，单机离线运行，无第三方依赖。

## 功能

- **分帧器**：从字节流中切帧，容忍粘连帧与半帧（任意分块喂入结果一致）
- **按 seq 重传请求**：乱序帧进入重排缓冲，缺口触发 `retransmit_request`（NAK）
- **去重缓存**：重复 seq（含超时重传）直接丢弃，绝不重复入账
- **虚拟时钟超时重试**：`--clock N` 设定超时（1 tick = 1 输入字节），缺口挂起
  超过 N tick 未补齐则发出 `retransmit_retry`，最多 3 次；`--clock 0` 关闭重试
- **UNDO 规则**：只能撤销同一工单最近未闭环（未被 UNDO 闭环）且未被后续
  WELD_START 覆盖的 WELD_END；撤销生成反向事件 `weld_undo`（含 `undoes` 指向
  原事件 id），原事件保留。跨工单 UNDO、已闭环 UNDO、被后续 START 覆盖的
  UNDO 均为协议违例，状态不变，exit 3

## 帧格式（自定义，小端流）

```
偏移  字段    说明
0     magic   0xAB
1     magic   0xCD
2     len     payload 长度（1..64）
3-4   crc16   CRC-16/CCITT-FALSE，大端，覆盖 [len, seq, ack, type, payload]
5     seq     帧序号（mod 256）
6     ack     保留/回显
7     type    0x01=WELD_START, 0x02=WELD_END, 0x03=UNDO
8..   payload 工单号，可打印 ASCII
```

## 使用

```bash
node cli.js --in trace.hex --clock 0 --out out.ndjson
# 或从 stdin 读、写到 stdout：
cat trace.hex | node cli.js --clock 5
```

- `--in`：十六进制流文件（空白字符忽略）；缺省读 stdin
- `--out`：NDJSON 输出文件；缺省写 stdout
- `--clock N`：虚拟时钟超时（tick），0 = 不重试（默认 0）

退出码：`0` 成功（输出事件 + 证书）；`2` 解析错误（输出
`{"error":{"code","offset"}}`）；`3` 协议违例；`4` 用法错误。

解析错误码：`BAD_HEX` `BAD_MAGIC` `BAD_LEN` `BAD_CRC` `UNKNOWN_TYPE`
`BAD_PAYLOAD` `TRUNCATED`；协议违例码：`END_WITHOUT_START`
`UNDO_NOT_ALLOWED` `SEQ_GAP`。

## 真实运行结果

`examples/trace.hex`（由 `node examples/make-trace.js` 生成，96 字节 8 帧，
含 seq 1 重复帧与 seq 6 先于 seq 5 到达的乱序）：

```
$ node cli.js --in examples/trace.hex --clock 0 --out out.ndjson   # exit 0
{"type":"weld_start","id":1,"wo":"WO-1","seq":0,"tick":12}
{"type":"weld_end","id":2,"wo":"WO-1","seq":1,"tick":24}
{"type":"weld_start","id":3,"wo":"WO-2","seq":2,"tick":48}
{"type":"weld_end","id":4,"wo":"WO-2","seq":3,"tick":60}
{"type":"weld_undo","id":5,"wo":"WO-2","seq":4,"tick":72,"undoes":4}
{"type":"retransmit_request","seq":5,"tick":84}
{"type":"weld_start","id":6,"wo":"WO-3","seq":5,"tick":96}
{"type":"weld_end","id":7,"wo":"WO-3","seq":6,"tick":96}
{"type":"certificate","frames":8,"duplicates":1,"retransmitRequests":1,"retries":0,"events":7,"workOrders":3,"openWorkOrders":[],"finalTick":96,"stateHash":"6be733f725fd3df83c8df958b9a3a56b8ac38b69f13abfc9d3866f6ea3fc3e4a"}
```

重复 seq 1 只入账一次（`duplicates:1`），乱序的 seq 6 在 seq 5 到达后按序
放行，事件顺序与参考枚举一致。

虚拟时钟超时重试（seq 1 延迟到达，`--clock 5`）：

```
$ node cli.js --in retry.hex --clock 5                          # exit 0
{"type":"weld_start","id":1,"wo":"WO-1","seq":0,"tick":12}
{"type":"retransmit_request","seq":1,"tick":24}
{"type":"retransmit_retry","seq":1,"attempt":1,"tick":29}
{"type":"retransmit_retry","seq":1,"attempt":2,"tick":34}
{"type":"retransmit_retry","seq":1,"attempt":3,"tick":39}
{"type":"weld_end","id":2,"wo":"WO-1","seq":1,"tick":48}
{"type":"weld_start","id":3,"wo":"WO-2","seq":2,"tick":48}
{"type":"weld_end","id":4,"wo":"WO-2","seq":3,"tick":48}
{"type":"certificate","frames":4,"duplicates":0,"retransmitRequests":1,"retries":3,"events":4,"workOrders":2,"openWorkOrders":[],"finalTick":48,"stateHash":"8c0fd4efd34b768f11777f346baa5a8643cd68d5b4228143fffbdc53f2d6af10"}
```

解析错误（第二帧 CRC 损坏）：

```
$ node cli.js --in badcrc.hex --clock 0                         # exit 2
{"type":"weld_start","id":1,"wo":"WO-1","seq":0,"tick":12}
{"error":{"code":"BAD_CRC","offset":12}}
```

协议违例（跨工单 UNDO，状态不变）：

```
$ node cli.js --in badundo.hex --clock 0                        # exit 3
{"type":"weld_start","id":1,"wo":"WO-A","seq":0,"tick":12}
{"type":"weld_end","id":2,"wo":"WO-A","seq":1,"tick":24}
{"error":{"code":"UNDO_NOT_ALLOWED","offset":24}}
```

## 测试

```
$ node --test
# tests 4
# pass 4
# fail 0
```

- `test/framer.test.js`：粘连帧、半帧逐字节恢复、每个切分点重放一致、
  截断/CRC/魔数/类型错误及 offset
- `test/gateway.test.js`：验收 1（粘连半帧恢复后事件顺序等于参考枚举，并
  暴力枚举全部切分点）、验收 2（重复 seq 与超时重传不重复入账、乱序 NAK +
  重试 + 单次入账）、验收 3（跨工单 UNDO / 已闭环 UNDO / 被后续 START 覆盖
  的 UNDO 均 exit 3 且状态不变）
- `test/replay.test.js`：验收 4，200 组随机小流 × 20 次随机分块暴力重放，
  结果与一次性处理逐字节一致；另有 50 组逐字节喂入对照
- `test/cli.test.js`：CLI 退出码 0/2/3/4、stdin/文件输入、NDJSON 输出

## 结构

```
cli.js            CLI 入口（main 可注入 IO，便于进程内测试）
src/frame.js      帧编解码常量与 encodeFrame
src/framer.js     流式分帧器（粘连/半帧）
src/gateway.js    seq 排序、去重缓存、重传/重试、工单状态机、证书
src/processor.js  字节流 → 事件/证书/错误（虚拟时钟 1 tick = 1 字节）
src/crc16.js      CRC-16/CCITT-FALSE
src/hex.js        十六进制流解码
examples/         trace.hex 生成脚本与样例
testlib/          测试帧构造工具
```
