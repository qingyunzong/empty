# packline-sync

包装线视觉终端的离线事件同步库与 CLI。Node.js 22+,仅使用标准库,单机离线运行。

## 事件模型

每个事件字段:`batch`、`item`、`seq`、`lamport`、`kind`、`ref`、`qty`、`reason`、`sig`。

- `kind` ∈ `PACK` / `REWORK` / `SCRAP` / `CORRECT`。
- `id` = sha256(规范 JSON(签名域字段)),内容寻址,用于去重与 `ref` 引用。
- `sig` = HMAC-SHA256(key, id);密钥取环境变量 `PACKLINE_HMAC_KEY`,缺省为内置开发密钥。
- `CORRECT` 通过 `ref` 引用**同一 item** 的先前事件,只允许更正 `qty` 与 `reason`,
  不得更改 `item`/`batch`(违反按帧错处理,exit 2)。被更正事件保留并标记 `superseded`,
  更正可链接(`CORRECT` 引用 `CORRECT`),逻辑上最后的有效更正生效。
- `SCRAP` 为终态:之后(按 lamport 序)仅接受管理更正 `CORRECT(reason="audit")`,
  且不会复活该 item(状态保持 `SCRAPPED`,仅数量/原因被修正)。

## 帧格式(线协议)

```
magic   2B   'P' 'K' (0x50 0x4b)
length  2B   payload 字节数(大端)
payload NB   事件的规范 JSON(含 id、sig)
crc32   4B   payload 的 CRC-32(node:zlib.crc32,大端)
```

协议层(`src/frame.js`、`src/protocol.js`):

- **分帧**:`FrameDecoder` 为流式解码器,任意切块(哪怕 1 字节)都能正确重组。
- **重复**:接收方按事件 `id` 去重,重传帧幂等。
- **乱序**:应用层所有派生状态都是事件全集的确定性函数,任意到达序收敛到同一终态。
- **超时重传**:`Retransmitter` 跟踪未确认帧,超时由 `due(now)` 重发,配合去重实现恰好一次。

## 应用层

`src/engine.js` 的 `Engine`:

- `apply(event)`:到达序应用;返回 `applied` / `duplicate`。
- `finalize()`:校验引用完整性(exit 9)、更正环(exit 2)、SCRAP 终态(exit 10)。
- `getItemState(item)` / `snapshot()`:每 item 最终态(status/qty/reason/...)。
- `contentHash()`:增量内容哈希;`recomputeContentHash()`:从事件日志全量重算。

### 内容哈希(增量,无隐藏状态)

内容哈希 = sha256(`packline-trace/1` ‖ validCount ‖ XOR(所有有效事件 id))。
事件变为有效/被取代时,只需 XOR 进/出它的 id 并增减计数 —— 增量状态(XOR 累加器 +
计数)完全可由事件日志重算导出,除此之外没有任何隐藏状态;测试逐步断言增量值与
全量重算一致,且乱序到达终态哈希相同。

## 导出追溯包

`exportPackage()` / `--export` 输出 `packline-trace/1` JSON:

- `events`:全部事件(含被取代事件,保留并带 `superseded` 标志)。
- `validEvents`:有效事件 id 列表。
- `supersededChains`:每条取代链 `{root, chain, effective, superseded}`。
- `items`:每 item 最终态。
- `contentHash` / `validCount` / `eventCount`。

## 退出码

| code | 含义 |
| ---: | --- |
| 0 | 成功 |
| 1 | 用法 / IO 错误 |
| 2 | 帧错(magic/crc/JSON/schema/签名/非法 hex/更正环/跨 item 更正) |
| 9 | `ref` 引用不存在 |
| 10 | SCRAP 终态违例 |

## 使用

```bash
# 生成示例帧流(含乱序与一次重传重复)
node examples/make-frames.js > frames.hex

# 解码、应用、导出追溯包
node cli.js frames.hex --export pkg.json
```

## 测试

```bash
node --test
```

四条验收的对应测试(`test/engine.test.js`):

1. 重复 CORRECT 幂等 — `duplicate CORRECT is idempotent`
2. 乱序中间态不同、终态与参考一致 — `out-of-order delivery converges to the reference final state`
3. SCRAP 后普通更正拒绝 — `plain correction after SCRAP is rejected (exit 10)`
4. 全量重算 vs 增量哈希 — `incremental hash matches full recompute at every step and across orders`

## 真实测试记录(2026-10-02,Node v22.22.1)

`node --test`:

```
ok 1 - test/cli.test.js
ok 2 - test/engine.test.js
ok 3 - test/frame.test.js
ok 4 - test/helpers.js
ok 5 - test/protocol.test.js
# tests 5
# pass 5
# fail 0
```

共 23 个子测试全部通过(engine 9、frame 7、protocol 2、cli 5)。

CLI 实测:

```
$ node examples/make-frames.js > frames.hex && node cli.js frames.hex --export pkg.json
events: 6 applied, 1 duplicate(s); items: 2; contentHash: 7c338f82...8ca704   # exit=0
$ node cli.js bad9.hex --export out.json   # 未知 ref
error(exit 9): CORRECT 86a3c5a0... references unknown event 0000...            # exit=9
$ node cli.js bad10.hex --export out.json  # SCRAP 后普通更正
error(exit 10): event 5f2f7e44... (CORRECT) violates SCRAP terminal state ...  # exit=10
$ node cli.js bad2.hex --export out.json   # 帧损坏
error(exit 2): frame crc mismatch                                            # exit=2
```
