# DvP 证券款券对付配对引擎

Node.js 22、仅标准库、单机离线。输入改单指令帧（JSONL），输出成交 / 剩余 / 冻结 / 失败补偿事件流与可重放审计根。

## 运行

```bash
node cli.js <in.jsonl>                      # 无账户约束（额度无限）
node cli.js --config examples/config.json examples/demo.jsonl
node cli.js --window 50 <in.jsonl>          # 覆盖撮合窗口
node cli.js --crc '<frame-json>'            # 为帧计算 crc（签名工具）
node --test                                 # 全部测试
```

退出码：`0` 正常；`2` 帧错（JSON 非法 / 字段非法 / crc 不匹配）；`3` 未知 origId；`4` 重复 clOrdId 且载荷不同。

## 帧格式

每行一个 JSON 对象（支持 CRLF、空行、末行无换行；解码器按任意分块流式重组，见 `src/frame.js`）。`crc` 为 CRC-32（IEEE），对「去掉 crc 字段后的规范 JSON（键排序、无空白）」的 UTF-8 字节计算，8 位小写十六进制。

| op     | 必填字段                                            | 可选字段        |
|--------|-----------------------------------------------------|-----------------|
| new    | op, clOrdId, side(buy/sell), qty, price, seq, crc   | acct, ts        |
| amend  | op, clOrdId, origId, seq, crc（qty/price 至少其一） | qty, price, ts  |
| cancel | op, clOrdId, origId, seq, crc                       | ts              |
| match  | op, clOrdId, seq, crc                               | ts              |
| settle | op, clOrdId, origId(=tradeId), seq, crc             | ts              |
| fail   | op, clOrdId, origId(=tradeId), seq, crc             | ts              |

- `qty`、`price` 为正整数（price 为最小货币单位，避免浮点误差）；`seq`、`ts` 为非负整数。
- 字段白名单严格校验，多余字段视为帧错（exit 2），保证 crc 覆盖全部有效载荷。
- `acct` 缺省为 `default`；未在 config 中配置的账户额度无限。

## 语义规则

- **日志序**：所有帧先按 `seq` 升序（到达次序决胜）重排再处理；乱序到达不影响结果。cancel 与 match 同刻（同 ts）竞态由日志序（seq）决定。
- **重传 / 去重**：`clOrdId` 为幂等键。完全相同的帧（含 seq/crc）重传只处理一次，审计根不变；同 clOrdId 不同载荷 → exit 4。
- **虚拟时钟**：`ts` 为虚拟时间（缺省取 `seq`），时钟单调前进。撮合窗口 `window`（默认 1000）：开放订单自进入起超过窗口未配对，剩余量释放（`expired` 事件）。
- **优先级**：价格优先 → 时间（prioTs）优先 → 同价同刻按 `clOrdId` 升序。改价格丢失时间优先（prioTs 重置为当前时刻），仅改量保留。成交价为 maker（更早挂单）价格。
- **部分成交**：每轮 match 按优先级循环配对最优买卖，成交量为双方剩余最小值，剩余量继续挂单。
- **amend**：不得改变已成交部分——新 qty 小于已成交量则整笔拒绝（`amendCrossesFilled`），否则剩余量 = 新 qty − 已成交。
- **DvP 双额度冻结**：成交时同时检查买方现金（qty×price）与卖方证券，分别冻结（available→frozen）。任一边不足则**整笔配对拒绝**（`matchRejected`），双方均不扣减，该方本轮跳过。
- **settle 最终化**：冻结额过户（买方得券、卖方得款）。settle 后不可抹账，只能 `fail` 补偿：追加一笔反向补偿记录（`compensated`，编号 C1…），原成交记录保留，账本仅追加。
- **审计根**：每条事件按 `sha256(prevHash + "\n" + canonical(event))` 链式累积，末行输出 `{"type":"audit","events":N,"root":...}`。同一逻辑日志（任意到达次序、任意重传）必得同一根，可重放校验。
- 语义级拒绝（改已成交、撤已闭单、重复 settle 等）产生 `rejected` 事件并继续处理；只有未知 origId（exit 3）、clOrdId 冲突（exit 4）、帧错（exit 2）终止进程。

## 输出事件

`order` / `amended` / `canceled` / `expired` / `trade` / `freeze`（含配置账户余额快照）/ `remaining` / `matchRejected` / `rejected` / `settled` / `compensated` / `end`（终态汇总）/ `audit`（审计根）。

## 真实输出

`node cli.js --config examples/config.json examples/demo.jsonl`（演示：部分成交、amend 穿越已成交被拒、DvP 资金不足拒绝、settle 后 fail 补偿、窗口超时释放）：

```
{"type":"order","seq":1,"clOrdId":"B1","side":"buy","acct":"A","qty":100,"price":1000,"remaining":100}
{"type":"order","seq":2,"clOrdId":"S1","side":"sell","acct":"B","qty":60,"price":990,"remaining":60}
{"type":"trade","seq":3,"tradeId":"T1","buyId":"B1","sellId":"S1","qty":60,"price":1000}
{"type":"freeze","seq":3,"tradeId":"T1","acct":"A","asset":"cash","qty":60000,"balances":{"cashAvail":40000,"cashFrozen":60000,"secAvail":0,"secFrozen":0}}
{"type":"freeze","seq":3,"tradeId":"T1","acct":"B","asset":"sec","qty":60,"balances":{"cashAvail":0,"cashFrozen":0,"secAvail":440,"secFrozen":60}}
{"type":"remaining","seq":3,"clOrdId":"B1","filled":60,"remaining":40}
{"type":"remaining","seq":3,"clOrdId":"S1","filled":60,"remaining":0}
{"type":"rejected","seq":4,"instr":"AM1","op":"amend","origId":"B1","reason":"amendCrossesFilled","filled":60}
{"type":"amended","seq":5,"instr":"AM2","clOrdId":"B1","qty":80,"price":1000,"remaining":20}
{"type":"order","seq":6,"clOrdId":"S2","side":"sell","acct":"B","qty":50,"price":1010,"remaining":50}
{"type":"order","seq":7,"clOrdId":"B2","side":"buy","acct":"C","qty":50,"price":1010,"remaining":50}
{"type":"matchRejected","seq":8,"reason":"insufficientCash","buyId":"B2","sellId":"S2","qty":50,"price":1010}
{"type":"canceled","seq":9,"instr":"CX1","clOrdId":"B2","released":50}
{"type":"settled","seq":10,"instr":"ST1","tradeId":"T1"}
{"type":"compensated","seq":11,"instr":"F1","compId":"C1","tradeId":"T1","qty":60,"amount":60000}
{"type":"order","seq":12,"clOrdId":"S3","side":"sell","acct":"B","qty":10,"price":900,"remaining":10}
{"type":"trade","seq":13,"tradeId":"T2","buyId":"B1","sellId":"S3","qty":10,"price":1000}
{"type":"freeze","seq":13,"tradeId":"T2","acct":"A","asset":"cash","qty":10000,"balances":{"cashAvail":90000,"cashFrozen":10000,"secAvail":0,"secFrozen":0}}
{"type":"freeze","seq":13,"tradeId":"T2","acct":"B","asset":"sec","qty":10,"balances":{"cashAvail":0,"cashFrozen":0,"secAvail":490,"secFrozen":10}}
{"type":"remaining","seq":13,"clOrdId":"B1","filled":70,"remaining":10}
{"type":"remaining","seq":13,"clOrdId":"S3","filled":10,"remaining":0}
{"type":"expired","seq":14,"clOrdId":"B1","released":10}
{"type":"expired","seq":14,"clOrdId":"S2","released":50}
{"type":"end","orders":[{"clOrdId":"B1","side":"buy","qty":80,"price":1000,"filled":70,"remaining":0,"state":"expired"},{"clOrdId":"S1","side":"sell","qty":60,"price":990,"filled":60,"remaining":0,"state":"filled"},{"clOrdId":"S2","side":"sell","qty":50,"price":1010,"filled":0,"remaining":0,"state":"expired"},{"clOrdId":"B2","side":"buy","qty":50,"price":1010,"filled":0,"remaining":0,"state":"canceled"},{"clOrdId":"S3","side":"sell","qty":10,"price":900,"filled":10,"remaining":0,"state":"filled"}],"trades":[{"tradeId":"T1","buyId":"B1","sellId":"S1","qty":60,"price":1000,"state":"compensated"},{"tradeId":"T2","buyId":"B1","sellId":"S3","qty":10,"price":1000,"state":"matched"}],"accounts":[{"acct":"A","cashAvail":90000,"cashFrozen":10000,"secAvail":0,"secFrozen":0},{"acct":"B","cashAvail":0,"cashFrozen":0,"secAvail":490,"secFrozen":10},{"acct":"C","cashAvail":5000,"cashFrozen":0,"secAvail":0,"secFrozen":0}]}
{"type":"audit","events":24,"root":"3365d2f6dacb9361eb21272db4ccb55dc56a4d468983d39eae6a4124885746a4"}
```

`node --test` 真实结果：`# tests 4 / # pass 4 / # fail 0`（4 个测试文件，25 个用例；其中交错枚举对照独立参考实现共 1050 种合法交错：5 指令 60 种、6 指令 360 种、7 指令 630 种）。

## 验收对照

1. **amend 穿越已成交** → `test/engine.test.js`「acceptance 1」：qty 30 < 已成交 40 被拒，qty 50 成交部分不变。
2. **cancel 与 match 同刻决胜** → 「acceptance 2」：同 ts 下 seq 小者胜，两种次序各验证。
3. **资金足证券不足拒绝** → 「acceptance 3/3b」：整笔配对拒绝，双方余额零扣减。
4. **窗口超时未配对释放** → 「acceptance 4」：`expired` 事件释放全部剩余。
5. **≤7 指令枚举所有合法交错** → `test/interleave.test.js`：与独立编写的朴素参考撮合器逐状态深比较。

## 结构

```
cli.js            命令行入口（参数、退出码、事件输出）
src/frame.js      流式分帧解码 + 帧校验（schema/crc）
src/crc32.js      CRC-32（IEEE）
src/canon.js      规范 JSON 序列化
src/runner.js     重传去重 + seq 重排
src/engine.js     撮合引擎（优先级/DvP/冻结/settle/fail/窗口/审计链）
test/             node:test 测试
testutil/sign.mjs 测试帧签名辅助
examples/         演示输入与账户配置
```
