# netclear

多币种双边支付净额清算库与 CLI（Node.js 22，仅标准库，无外部依赖）。

## 核心语义

1. **换算**：所有交易按当前汇率版本折算为基准货币（定点小数，SCALE=10⁻⁶，BigInt 精确运算，half-up 舍入）。
2. **净额图约简**：按参与方构建债务有向图，分解为强连通分量（SCC）。每个 SCC 内：
   - **阶段 1**：按字典序对所有互反边做双边抵消（2-环）；
   - **阶段 2**：对剩余 ≥3 环做环约简——确定性地找到环（排序邻接 DFS），扣减瓶颈额，重复直至无环。
   - 先双边后多边保证：清算量恒不超过纯双边抵消基线；每方净头寸在任何合法净额下不变。
3. **冻结额度约束**：解开一个环要求环上每方能冻结瓶颈额（`limit ≥ bottleneck`，边界恰好相等可通过）；净额后的净应付额构成最终 `locks`，不得超过各方冻结额度，否则 `LIMIT`。
4. **清算窗口容量**：全部 locks 之和不得超过 `windowCapacity`，否则 `LIMIT`（`scope: "window"`）。
5. **未决环不是不可满足**：存在环时一律先尝试净额；仅当环上某方冻结额度低于瓶颈额时才报 `CYCLE_LOCKED`，并给出**最小冲突集**——基本环（边的任何真子集都不成环）+ 恰好不足额的参与方 + 构成环边的交易 id。

## 增量与可逆

- 引擎维护操作日志（`addTrades` / `voidTrade` / `correctRate`），`replay()` 从初始配置重放日志，逐位复现同一状态（同一 `inputHash`）。
- `correctRate` 追加新汇率版本；`settle()` 以 SCC 边内容哈希为缓存键，**只重算受影响净额环**，未受影响的环直接命中缓存（见输出 `trace.components[].recomputed` 与 `trace.affected`）。
- `voidTrade` 撤销交易并在下次结算时释放其冻结额度；撤销不存在或已撤销的交易会释放不存在的额度，报 `NEGATIVE_RELEASE`。

## 确定性

同一交易集合 + 同一汇率版本 ⇒ 相同输出字节：交易按 id 排序聚合，SCC/环遍历全部按字典序，环取规范旋转（最小节点在前），输出数组全部排序。输入顺序打乱不影响结果。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `RATE_STALE` | 请求的汇率版本 ≠ 当前版本 |
| `RATE_MISSING` | 某币种在请求版本中无汇率 |
| `LIMIT` | 冻结额度或清算窗口容量不足（`scope: party/window`） |
| `CYCLE_LOCKED` | 环因额度不足无法净额，附最小冲突集 |
| `NEGATIVE_RELEASE` | 撤销未知/已撤销交易（释放超过冻结） |
| `INPUT_INVALID` | 输入格式非法 |

## 输入格式

`trades.json`：
```json
{
  "ratesVersion": 2,
  "windowCapacity": "10000",
  "limits": { "A": "500" },
  "trades": [{ "id": "t1", "from": "A", "to": "B", "currency": "USD", "amount": "100" }]
}
```
- `ratesVersion` 省略时用当前版本；`limits` 整体省略表示不约束，省略某方表示该方额度为 0；`windowCapacity` 省略表示不约束。
- 金额/汇率：十进制字符串或数字，最多 6 位小数。

`rates.json`：
```json
{
  "base": "USD",
  "versions": [
    { "version": 1, "rates": { "EUR": "1.10" } },
    { "version": 2, "rates": { "EUR": "1.20" } }
  ]
}
```
版本为部分覆盖表，生效汇率为各版本按序合并；仅允许用当前（最大）版本结算。

## 输出

```json
{
  "ok": true,
  "netPositions": [{ "party": "A", "net": "-65", "pay": "65", "receive": "0" }],
  "locks": [{ "party": "A", "locked": "65", "limit": "500", "available": "435" }],
  "netObligations": [{ "from": "A", "to": "B", "amount": "40", "trades": ["t1"] }],
  "window": { "capacity": "10000", "used": "65" },
  "proof": {
    "inputHash": "<sha256 of canonical inputs>",
    "rulesVersion": "netting-rules/1.0.0",
    "ratesVersion": 2,
    "base": "USD"
  },
  "trace": { "components": [...], "affected": {...}, "cache": { "hits": 1, "misses": 0 } }
}
```
金额一律输出为十进制字符串。`proof.inputHash` 覆盖：活动交易（规范化排序）、生效汇率、额度、窗口容量与规则版本。

## 用法

```bash
node cli.js examples/trades.json examples/rates.json   # 结果 JSON 写 stdout
node --test                                            # 运行全部测试
```

库 API：
```js
import { NettingEngine } from './src/engine.js';
const engine = new NettingEngine({ rates, limits, windowCapacity });
engine.addTrades(trades);
engine.correctRate('EUR', '1.25');   // 追加新汇率版本
engine.voidTrade('t1');              // 撤销并释放冻结
const result = engine.settle();      // 增量重算
const replayed = engine.replay().settle(); // 日志重放，状态一致
```

## 测试

- `test/netting.test.js`：双边抵消、多币种环净额、LIMIT/窗口边界（恰好相等通过、超 1 个最小单位失败）、`CYCLE_LOCKED` 最小冲突集、`RATE_STALE`、确定性。
- `test/bruteforce.test.js`：n≤8 随机图（200 个种子）与"枚举所有双边抵消"的参考实现对照净头寸，且引擎清算量 ≤ 双边基线。
- `test/engine.test.js`：汇率更正只重算相关环（且与全量重算结果一致）、撤销释放冻结并可重放、`NEGATIVE_RELEASE`。
- `test/cli.test.js`：CLI 端到端（成功与各错误码的 JSON 输出、退出码、跨运行确定性）。
