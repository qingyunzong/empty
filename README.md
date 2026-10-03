# batch-trace

离散制造批次质量追溯库与 CLI（单机离线，Node.js 22，零依赖）。
所有数量以 BigInt 有理数（`Rational`，分子/分母最简分数）精确累计，无浮点漂移。

## 功能

- **split(batch, ratios…, childIds…)**：按有理比例拆分；比例必须全部为正且和**恰为 1**，否则 `E_RATIONAL`。
- **join(inputIds, outputId, lossRate)**：合并输入批次；输出量 = 输入和 × (1 − 损耗率)，损耗率 ∈ [0, 1)，越界 `E_RATIONAL`。
- **quarantine(batch)**：隔离批次。
- **增量提交事务**：`ledger.begin()` 内每步立即生效；任一步失败自动回滚整批（`tx.rollback()`），`tx.commit()` 提交。
- **undo/redo**：提交后的事务进入撤销栈，`ledger.undo()` / `ledger.redo()`。
- **族谱查询**：`ancestors` / `descendants` / `pathRatios(from, to)`（枚举每条路径及其累计有理比例）。
- **污染查询**：`contamination(outputId)` 给出污染证书（隔离批次 → 输出的所有路径及累计比例）；`contaminates(qid, out)` 布尔判定。
- **循环族谱**：join 若会形成环（输出是某输入的祖先或自身）抛 `E_CYCLE`；路径枚举亦有环路防护。
- **小数输出**：`formatQuantity(q, decimals)` 同时返回十进制值、精确分数、实际舍入误差与误差界（半个最小单位），误差保证不超过该单位的一半（`withinBound`）。

## CLI

```sh
node cli.js [--state FILE] create R 8
node cli.js split R A=1/2 B=1/3 C=1/6
node cli.js join J A,B 1/5          # 输出 = (A+B) × 4/5
node cli.js quarantine A
node cli.js exec ops.json           # 多操作单事务，全做或全不做
node cli.js undo / redo
node cli.js show J --decimals 3     # 十进制 + 精确分数 + 误差界
node cli.js ancestors C / descendants R / ratio R J
node cli.js contaminates A J / contamination J
node cli.js inventory
```

状态持久化在 `--state` 指定的 JSON 文件（默认 `trace-state.json`，含 undo/redo 栈）。
出错时向 stderr 打印 `error E_xxx: …` 并以退出码 1 结束。

## 库 API 示例

```js
import { Ledger } from './src/ledger.js';

const ledger = new Ledger();
ledger.create('R', '8');
const tx = ledger.begin();
tx.split('R', ['1/2', '1/3', '1/6'], ['A', 'B', 'C']);
tx.join(['A', 'B'], 'J', '1/5');
tx.commit();                 // 任一步抛错则整批自动回滚
ledger.undo(); ledger.redo();
ledger.pathRatios('R', 'J'); // => 每条路径的累计有理比例
```

## 测试

```sh
node --test
```

覆盖验收标准：
1. `test/acceptance.test.js` — 8 批次拆分合并树，用独立路径枚举核对每个批次的累计比例与数量；
2. 比例和少 1/1000000 → `E_RATIONAL`，事务回滚，库存逐字节不变；
3. 零损耗 join、相切比例（1/2+1/3+1/6、999999/1000000+1/1000000）成立；
4. 撤销 join 后污染证书消失，redo 后恢复；
5. 非法比例 → `E_RATIONAL`，循环族谱 → `E_CYCLE`；
6. `test/rational.test.js` — 扫描 11100 组分数×小数位，验证舍入误差 ≤ 半个单位。

### 真实测试记录（2026-10-03，node v22.22.1）

```
$ node --test
TAP version 13
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
# Subtest: test/cli.test.js
ok 2 - test/cli.test.js
# Subtest: test/ledger.test.js
ok 3 - test/ledger.test.js
# Subtest: test/rational.test.js
ok 4 - test/rational.test.js
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7281.697187
```

退出码：**0**
