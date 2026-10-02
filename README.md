# evpack — 离线监管证据包校验器

Node.js 22、仅标准库、`node:test`。证据包 = 证据行 + 排除规则 + 汇总结论。
提交前离线校验，并生成可复核证书；局部证据撤回时增量处理，不重扫全库。

## 数据模型

- **证据行** `{ "key": "d1", "state": "asserted|unknown|retracted", "attrs": {...} }`
  （`state` 缺省 `asserted`；`attrs` 可内联为顶层字段）。来自 `<dir>/evidence.jsonl`
  与 `<dir>/evidence/*.json`。
- **排除规则** `{ "id": "r1", "priority": 9, "where": [pred...] }`：命中任意规则的证据
  从求值中排除。`verify` 输出触发规则中优先级最高者——同优先级并列**全部列出**
  （`bestRules`）。
- **声明（claim）** 受限关系代数：σ（`where` 合取谓词）→ γ（`aggregate`）→ 阈值
  （`expect`）。谓词：`eq ne lt lte gt gte in exists`；聚合：`count sum min max`
  （`field:"*"` 表示计数行）；期望：`lt lte gt gte`。

## 三值结论语义

| 状态 | 求值角色 |
| --- | --- |
| `asserted` | 确定计入（同时进入区间两端） |
| `unknown` | 存在性未决，只加宽可达区间 `[lo, hi]` |
| `retracted` | 已撤回但非反证，同样只加宽区间 —— **撤回导致 pass→undecided，而非 fail** |

- 期望在区间两端同真 → `pass`；同假 → `fail`；否则 → `undecided`。
- NULL 语义：谓词遇 NULL 字段不为真（`exists` 除外）；`sum/min/max` 忽略 NULL，
  空集得 NULL；`count` 空集为 0。NULL 可达（无 asserted 非空值）时期望为三值
  unknown → 结论 `undecided`。**unknown/NULL 显式进入 undecided，禁止当不可满足。**

## 增量校验（倒排索引）

`PackStore` 维护 `ruleToKeys`（规则→命中证据键）、`keyToRules`（证据键→规则，
反向索引）与字段等值索引。`retract(key)` 仅查反向索引、更新状态，
`scannedRows = 0`，不重匹配任何规则（`stats.ruleMatchEvals` 不变）；
等值谓词的 `verify` 走字段索引，扫描数远小于全库（见 `test/store.test.js`）。

## 证书

`cert` 仅在结论为 `pass`/`fail` 时签发（`undecided` → `E_UNDECIDED`）。证书含：
规范化 claim 及其哈希、`inputHash`（证据状态+规则+规则版本的 sha256）、
`ruleVersion`、命中证据键 `hitEvidenceKeys`、未决项 `undecided`、撤回项、
`bestRules`、签发时间与整体哈希。`cert --check` 重算正文哈希、比对当前
`inputHash` 并重放求值，任何篡改或过期 → `E_CERT_MISMATCH`。

## CLI

```sh
evpack load <dir>                       # 从目录（重）加载证据，保留已有规则
evpack rule add '<json>' [--dir D]      # 添加排除规则（重复 id → E_DUP_RULE）
evpack rule list [--dir D]
evpack retract <evidenceKey> [--dir D]  # 增量撤回（键不存在 → E_EVIDENCE_GONE）
evpack verify '<claim>' [--dir D]       # 打印三值结论（claim 可为 JSON、@文件）
evpack cert '<claim>' [--dir D] [--out f]
evpack cert --check <cert.json> [--dir D]
```

`--dir` 缺省 `$EVPACK_DIR` 或 `.`；状态存于 `<dir>/evpack.store.json`。
退出码：`0` 正常，`1` 输入非法，`2` E_DUP_RULE，`3` E_EVIDENCE_GONE，
`4` E_UNDECIDED，`5` E_CERT_MISMATCH。

## 测试

```sh
node --test        # 全部测试；最近一次真实运行结果见 test-results.txt
```

- `test/diff.test.js`：500 证据 × 400 随机声明，与枚举所有不确定子集的
  小参考实现对拍（结论、命中键、未决键逐项一致）；另有 60 步撤回风暴对拍。
- `test/acceptance.test.js`：验收 2（撤回 pass→undecided）、3（同优先级并列
  最优规则全部列出）、4（证书篡改/过期检测）。
- `test/cli.test.js`：CLI 端到端（经 `runCli` 进程内调用，覆盖退出码）。
