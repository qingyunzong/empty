# 撤销链状态机（reversal-chain）

支付运营台误扣款撤销的可验证状态机：库 + CLI，Node.js 22，仅标准库。

## 事件模型（JSONL，每行一个事件）

```json
{"type":"tx","eventId":"e1","logicalClock":1,"txId":"t1","amount":100}
{"type":"reversal","eventId":"e2","logicalClock":2,"txHash":"<tx事件的SHA-256>","amount":60}
{"type":"reinstate","eventId":"e3","logicalClock":3,"reversalHash":"<reversal事件的SHA-256>","amount":60}
```

- 事件哈希 = 事件 canonical JSON 的 SHA-256；撤销引用原交易哈希，再撤销（reinstate）引用撤销哈希。
- 撤销金额 ≤ 该交易剩余可撤销额（`amount - reversed + reinstated`）。
- 再撤销恢复可撤销额度，但不超过该撤销实际撤销额，故永不越过原交易上限。
- 同一 `eventId` 重复提交幂等（仅应用一次）；乱序输入按 `(logicalClock, eventId)` 排序重放。

## 证书链

每个被应用的事件生成一张证书：

```json
{"seq":0,"eventId":"e1","eventHash":"...","prevHash":"<genesis|上一张certHash>","stateHash":"...","certHash":"..."}
```

`certHash = SHA-256(canonicalJSON({eventHash,eventId,prevHash,seq,stateHash}))`，`stateHash` 为该步后状态快照的哈希。

## CLI

```sh
node cli.js apply events.jsonl state.json   # 应用事件，stdout 输出 JSONL 证书流，写 state.json
node cli.js verify state.json               # 重放并校验证书链，篡改报 E_CERT
```

错误（`E_AMOUNT` / `E_UNKNOWN_TX` / `E_UNKNOWN_REVERSAL` / `E_BAD_EVENT` / `E_CERT` / `E_IO`）写 stderr，退出码 1。

## 库

- `lib/machine.js`：`runChain` / `buildSnapshot` / `verifySnapshot` / `eventHash` / `reversibleRanges`
- `lib/canonical.js`：canonical JSON（键排序、无空白）

## 测试

```sh
node --test
```

结果见 `RESULTS.md`。
