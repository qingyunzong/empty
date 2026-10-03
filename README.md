# clearing-scan

清算报文扫描库与 CLI。Node.js 22，仅标准库，无网络依赖。

## 数据模型

- 报文文件：JSONL，每行一个 JSON 对象，字段 `clearingNo`（清算行号）、`counterparty`（对手方）、`currency`（币种）、`amount`（金额）、`memo`（附言）。
- 规则文件 `rules.json`：
  - `exact`: `[{"id":"E1","pattern":"urgent"}]` — 精确串集合，扫描 `memo` 字段，Aho-Corasick 多模式自动机。
  - `regex`: `[{"id":"R1","field":"amount","pattern":"[0-9]{5,}"}]` — 关键字段正则，编译为 DFA（ Thompson NFA → 子集构造），每个起始位置取最长匹配。
- 命中统一排序：起始位置 → 长度 → 规则 id（行号、字段为确定性的前后键）。

## CLI

```sh
node cli.js scan file.jsonl rules.json   # 输出 {"hits","proof","stats"}
node cli.js exec rules.json              # stdin 逐行 JSONL 命令
```

JSONL 命令：`{"cmd":"load","file":...}` / `{"cmd":"load","lines":[...]}`、`{"cmd":"patch","line":N,"text":"{...}"}`、`{"cmd":"scan"}`、`{"cmd":"verify","proof":{...}}`。

## 机制

1. **双自动机**：精确词表走 Aho-Corasick（含全部重叠命中）；正则子集编译为 DFA。两类命中合并后按 (start, length, ruleId) 排序。
2. **增量更正**：`patch` 替换一行后只重扫受影响窗口 `[N,N]`，返回区间证明（窗口、前后行哈希、前后根哈希、窗口外上下文哈希 `contextIntact`），结果与全量重扫一致。
3. **审计证书**：`proof` 含规则哈希、逐行 sha256、根哈希及每条命中的自动机状态轨迹摘要（`traceHash`）。`verify` 离线重放全部自动机并逐项比对；不以文件修改时间为正确性依据。

## 错误码

`DUP_RULE`（规则 id / 精确模式重复）、`BAD_PATCH`（补丁越界或非法 JSON）、`OFFSET_OVERFLOW`（超过 10 万行 / 5000 精确规则上限）、`PROOF_MISMATCH`（证书重放不一致）。

## 测试

```sh
node --test
```
