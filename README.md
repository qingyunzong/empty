# recon-match

银行分录与账务分录的对账匹配库及 CLI。仅使用 Node.js 标准库（Node 22），测试基于 `node:test`。

## 模型

- 分录：`{ "id": "B1", "amount": 10000 }`，金额为整数（最小货币单位）。
- 一条银行分录可匹配一条或多条账务分录。
- 两个匹配分支各自产生候选组合：
  - `exact`：账务分录合计与银行分录金额完全相等；
  - `fee`：合计与银行分录存在固定尾差，且 `|尾差| <= tolerance`，尾差计入手续费更正（`fee = bankAmount - ledgerSum`）。
- 候选编号按生成顺序从 1 递增：按银行分录顺序，每条银行分录先 `exact` 分支后 `fee` 分支，子集按大小升序、同大小按下标字典序枚举。
- 候选汇合时按编号升序贪心接受：若候选引用已被小编号候选占用的账务分录（或同一银行分录），则被拒绝（`status: "rejected"`, `reason: "conflict"`），保留编号较小者；被拒绝候选不占用任何分录，可继续复用。
- `confirm` 确认候选后生成匹配并占用分录；`undo` 撤销匹配，释放全部分录并回滚手续费更正。

## 事件

```json
[
  {"type": "init", "tolerance": 10, "bankEntries": [{"id": "B1", "amount": 100}], "ledgerEntries": [{"id": "L1", "amount": 60}, {"id": "L2", "amount": 40}]},
  {"type": "suggest"},
  {"type": "confirm", "candidate": 1},
  {"type": "undo", "match": "M1"}
]
```

## CLI

```
node src/cli.js <events.json> <workdir>
```

- 事件文件为 JSON 数组或 `{ "events": [...] }`。
- 所有事件（含建议、确认、撤销的结果）追加持久化到 `<workdir>/events.jsonl`；再次运行时先重放日志并校验重算结果与持久化结果一致（不一致报 `LOG_MISMATCH`），再应用新事件。重放产生相同的匹配证书与状态哈希。
- 成功：stdout 输出 `{ ok, stateHash, certificate, matches, candidates, eventsApplied }`，退出码 0。
- 失败：stderr 输出 `{"ok": false, "error": {"code", "message"}}`，退出码 1，且不写入任何新事件。

## 库

```js
const { ReconEngine, replay } = require('./src/recon');
const engine = new ReconEngine();
engine.applyEvent({ type: 'init', tolerance: 10, bankEntries, ledgerEntries });
engine.applyEvent({ type: 'suggest' });
engine.applyEvent({ type: 'confirm', candidate: 1 });
engine.certificate(); // 匹配证书
engine.stateHash();   // 证书的 sha256（键序规范化后）
```

## 测试

```
node --test
```

测试包含：精确一对多匹配；超 tolerance 拒绝与 tolerance 内手续费更正；分支冲突的确定性选择与复用；确认后撤销恢复未匹配状态；事件日志重放一致性；以及一个独立枚举器（对不超过 3 条银行、3 条账务分录枚举所有金额相等/容差内组合并独立求最小编号可行匹配）与引擎结果的随机化对照。
