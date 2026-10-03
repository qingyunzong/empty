# clearing-scan

清算报文风险扫描库与 CLI。Node.js 22，仅标准库，零依赖，单机离线。

## 模型

- 报文为 JSONL 行记录，字段：`lineNo`（清算行号）、`counterparty`（对手方）、
  `currency`（币种）、`amount`（金额）、`memo`（附言）。按行扫描原始行文本。
- 规则：`rules.json` 为 `{"rules":[{"id","type":"exact"|"regex","pattern"}]}`。
  - 精确串集合 → Aho-Corasick 多模式自动机（`src/aho.js`）。
  - 正则子集（字面量、`.`、字符类、`\d\w\s` 及取反、`|`、`()`、`* + ?`）
    → Thompson NFA → 子集构造 DFA（`src/regex-dfa.js`）。
  - 命中语义：任意完全匹配子串；统一按 (起始位置, 长度, 规则id) 排序。

## 增量更正

`patch` 替换一行后仅重扫受影响窗口 `[line, line]`（按行扫描使窗口精确），
原子写回文件，输出含窗口、前后行哈希、前后文件哈希的区间证明；
结果与全量重扫一致（验收 D）。

## 审计证书

`scan` 输出 proof：`rulesHash`/`fileHash`（SHA-256）、`hitsHash`、
每条命中的自动机状态轨迹摘要（AC trie 路径 / DFA 状态序列的哈希）及 `trajHash`。
`verify` 从当前文件与规则离线重放全部计算并逐项比对，任何篡改 → `PROOF_MISMATCH`。
正确性依据仅为内容哈希与重放，不使用文件修改时间。

## 用法

```sh
node cli.js scan file.jsonl rules.json            # 全量扫描，输出 hits/proof/stats
node cli.js verify file.jsonl rules.json proof.json
node cli.js                                        # stdin JSONL 命令模式
# {"cmd":"load","file":"...","rules":"..."}
# {"cmd":"patch","line":2,"record":{...}}
# {"cmd":"scan"}  {"cmd":"verify","proof":{...}}
```

错误码：`DUP_RULE`（规则 id/精确串重复）、`BAD_PATCH`（补丁越界或记录非法，
原文件不变）、`OFFSET_OVERFLOW`（超过 10 万行 / 5000 规则上限）、
`PROOF_MISMATCH`（证书重放不一致）。

## 测试

```sh
node --test
```
