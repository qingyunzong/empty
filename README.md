# index-audit：词典 / 倒排索引 / 文档存储 / 统计 一致性审计器

纯 Python 3.11 标准库实现（仅用到 `unicodedata` / `hashlib` / `json` /
`argparse` / `unittest` 等），不使用任何搜索服务或全文检索库。文档为本地
合成的 UTF-8 文本。审计过程**只读**；修复通过"先出计划、再校验基线、
最后应用"的两阶段方式完成。

## 目录结构

```
src/
  tokenizer.py   # 分词器（规则见下）
  workspace.py   # 工作区布局、四个组件的读写、版本与指纹
  builder.py     # 由文档文件构建全部四个组件
  audit.py       # 只读一致性审计器（去重 + 级联抑制）
  repair.py      # 修复计划生成与基线校验后应用
  cli.py         # build / audit / plan / apply / demo 命令
  demo.py        # 端到端演示
tests/           # unittest 测试（29 个用例）
```

## 分词规则

1. 输入按 UTF-8 解码，并做 Unicode **NFKC** 规范化（全角 `ＡＢＣ１２３`
   折叠为 `ABC123`）。
2. 对规范化文本做 `str.casefold()` 大小写折叠。
3. **词字符** = Unicode 通用类别以 `L`（字母）或 `N`（数字）开头的字符；
   其余一切字符（空白、标点、符号、下划线等）都是分隔符。
4. 词字符的极大连续段构成候选词；其中**汉字**（CJK 统一表意文字及扩展 A、
   兼容表意文字）逐字切分为单字词，连续的非汉字字母/数字保持为一个整体。

示例：`"Hello, 世界 foo_bar ＴＥＸＴ"` →
`hello, 世, 界, foo, bar, text`。

## 四个组件与版本

全部位于 `<root>/data/` 下，均为 JSON，且都带 `version` 字段；同一次构建
写出的四个组件版本相同：

| 组件 | 文件 | 内容 |
|---|---|---|
| 文档存储 | `docstore.json` | `docs: {doc_id: {file, sha256, num_tokens}}` |
| 词典 | `lexicon.json` | `terms: {term: {term_id, df, cf}}` |
| 倒排索引 | `index.json` | `postings: {term_id: [doc_id, ...]}`（排序去重） |
| 统计 | `stats.json` | `num_docs, num_terms, total_tokens` |

**基线指纹** = 按固定顺序对四个组件文件字节计算的 SHA-256，唯一标识一个
基线状态。

## 审计项（问题代码）

审计器交叉核对四个组件以及磁盘上的物理文档文件：

| 代码 | 含义 |
|---|---|
| `COMPONENT_MISSING` | 组件 JSON 文件缺失 |
| `VERSION_SKEW` | 四个组件版本不一致（合并为一个问题） |
| `MISSING_DOC_FILE` | 清单引用的文档文件不存在 |
| `ORPHAN_DOC_FILE` | 磁盘文件未在文档存储中注册 |
| `DOC_CONTENT_DRIFT` | 文件内容与清单 sha256 不符 |
| `MANIFEST_LENGTH_MISMATCH` | 清单 num_tokens 与重新分词结果不符 |
| `ORPHAN_DOC_REF` | 倒排索引引用了文档存储中不存在（已删除）的文档 |
| `MISSING_LEXICON_ENTRY` | 索引中出现词典未知的 term_id |
| `TERM_ID_COLLISION` | 多个词项共用同一 term_id |
| `ORPHAN_LEXICON_ENTRY` | 词典条目 df>0 但索引中无 postings |
| `DUPLICATE_POSTING` | posting 列表内 doc 重复 |
| `DF_MISMATCH` / `CF_MISMATCH` | 词典 df / cf 与索引、文档重新计算值不符 |
| `POSTINGS_DRIFT` | 索引 postings 与文档文件重新计算结果不符 |
| `STATS_MISMATCH` | 统计值与文档存储 / 词典不符 |

### 去重与级联抑制

- 问题以 `(code, entity)` 为唯一标识：**同一个被删文档被多少个词的
  postings 引用，都只计为 1 个 `ORPHAN_DOC_REF` 问题**，各 term_id 作为
  evidence 附上，不会因多表引用被重复计为多个独立错误。
- 由文档级问题（文件缺失、孤儿文件、悬空引用、内容漂移）可以解释的计数
  差异（cf、postings 漂移）不再单独立项，而是作为该文档级问题的 evidence。
- 有清单文档不可读时，依赖完整真值的检查（cf、postings 漂移）整体跳过并
  在报告中以 note 说明，避免级联误报。

## 修复计划与基线校验

`plan` 命令根据审计报告生成修复计划，计划中绑定
`baseline_version` 与 `baseline_fingerprint`；`apply` 在写入任何内容之前
重新校验二者：

- 版本不一致或指纹不一致 → 抛出 `BaselineMismatchError`，**不写任何文件**；
- 校验通过 → 执行成员决策类操作（`forget_doc` / `register_doc` /
  `drop_term` / `drop_index_term` / `resolve_collision`），随后从物理文档
  文件重建全部派生数据（清单哈希、postings、df/cf、统计），并将四个组件
  统一 bump 到新版本。

## 使用方法

```bash
python3.11 -m src.cli build --root demo_workspace      # 由 data/docs/*.txt 构建
python3.11 -m src.cli audit --root demo_workspace      # 只读审计（有问题时退出码 1）
python3.11 -m src.cli audit --root demo_workspace --json
python3.11 -m src.cli plan  --root demo_workspace      # 生成绑定基线的修复计划
python3.11 -m src.cli apply --root demo_workspace --plan demo_workspace/repair_plan.json
python3.11 -m src.cli demo  --root demo_workspace      # 端到端演示
```

## 运行样例

`python3.11 -m src.cli demo --root demo_workspace`（节选）：

```
=== 3. audit clean state ===
status: OK - no issues found

=== 5. audit corrupted state ===
status: 8 unique issue(s)
  [DF_MISMATCH] tokens
    - df=3 postings=1
  [MISSING_DOC_FILE] d04
  [MISSING_LEXICON_ENTRY] T999999
  [ORPHAN_DOC_FILE] d03.txt
  [ORPHAN_DOC_REF] d03
    - term_id=T000024 ... （20 条 evidence，仅计 1 个问题）
  [ORPHAN_LEXICON_ENTRY] ghostterm
  [STATS_MISMATCH] num_docs
  [STATS_MISMATCH] total_tokens
note: ground-truth checks (cf, postings drift) skipped: 1 manifest doc(s) unreadable

=== 6. write repair plan (bound to the current baseline) ===
{ "baseline_version": 1, "baseline_fingerprint": "cd2951e5...",
  "ops": [forget_doc d04, register_doc d03.txt, drop_index_term T999999,
          drop_term ghostterm, refresh_counts] }

=== 7. concurrent modification -> apply is refused ===
  refused as expected: baseline fingerprint mismatch: the workspace changed
  after the plan was created

=== 8. apply plan against the intact baseline ===
applied; components now at version 2

=== 9. final audit ===
status: OK - no issues found
```

## 测试结果

`python3.11 -m unittest discover -s tests -t .`：

```
.............................
----------------------------------------------------------------------
Ran 29 tests in 0.182s

OK
```

覆盖：分词规则（大小写折叠、NFKC、汉字单字词、下划线分隔等）、干净构建
零问题、审计只读（前后文件字节一致）、悬空引用去重、各类缺失/孤儿/计数
差异的检出、修复计划的基线版本与指纹校验（基线变动拒绝应用且不写文件）、
完整"损坏→计划→应用→复审干净"闭环。
