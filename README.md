# search-audit：词典 / 倒排 / 文档存储 / 统计 一致性审计

纯 Python 3.11 标准库实现（仅 `argparse / json / random / pathlib /
dataclasses / shutil / tempfile / unittest`），不使用任何搜索服务或全文
检索库。文档为本地合成的 UTF-8 文本。

## 数据布局

```
data/
├── docs/doc_0000.txt ...   # 原始 UTF-8 文档
├── docstore.json           # 文档存储: {"docs": {doc_id: {"path", "length"}}}
├── lexicon.json            # 词典:     {"terms": {term: {"term_id", "df"}}}
├── inverted_index.json     # 倒排:     {"postings": {term: [doc_id, ...]}}(有序去重)
└── stats.json              # 统计:     {"num_docs", "num_terms", "total_tokens"}
```

## 分词规则（tokenizer.py，唯一分词器）

1. 文档按 UTF-8 解码；
2. 全文做 `str.casefold()` 大小写折叠；
3. token 是满足 `ch.isalnum()` 为真的**最长连续字符段**（Unicode 字母与
   数字，含 CJK 表意文字，故“搜索”是一个 token）；
4. 其余字符（空白、标点、符号）均为分隔符，不进入 token；
5. token 按出现顺序输出、保留重复，保证文档长度与总词数可复算。

## 审计项（auditor.py，只读，绝不写数据集）

| 类别 | 问题类型 | 含义 |
| --- | --- | --- |
| 缺失 | `MISSING_DOC_FILE` | 文档存储指向的文件不存在 |
| 缺失 | `MISSING_POSTING` | 文档含该词但倒排缺此 posting |
| 缺失 | `MISSING_INDEX_ENTRY` | 词出现在文档中但倒排无此词条 |
| 缺失 | `MISSING_LEXICON_ENTRY` | 倒排/文档中的词未入词典 |
| 孤儿 | `ORPHAN_DOC_REFERENCE` | **倒排引用已删除文档** |
| 孤儿 | `ORPHAN_DOC_FILE` | 磁盘文件未在文档存储登记 |
| 孤儿 | `ORPHAN_LEXICON_ENTRY` | 词典词在倒排与所有文档中均不存在 |
| 计数 | `DF_MISMATCH` | 词典 df ≠ 倒排 posting 数 |
| 计数 | `DOC_LENGTH_MISMATCH` | 文档存储 length ≠ 重算 token 数 |
| 计数 | `STATS_MISMATCH` | stats 与其所汇总的表不一致 |
| 其他 | `STALE_POSTING` / `DUPLICATE_POSTING` | 陈旧 / 重复 posting |

**去重规则**：问题以 `(kind, term, doc, stat)` 为键。同一根因被多张表
佐证时只计一个问题，证据表合并进 `sources`；被 32 个 posting 列表引用
的已删文档只报 1 个 `ORPHAN_DOC_REFERENCE`；posting 本身不可信时不再
重复报该词的 `DF_MISMATCH`（df 差异是其症状而非独立问题）。

## 修复计划与基线校验（fixplan.py）

`build_plan` 把每个问题映射为幂等修复操作（删孤儿引用、补/删 posting、
补/删词典项、重建词条、修正文档长度、清除无法恢复的文档、纳入未登记
文件、重算 df、重算 stats）。`validate_plan` 做**基线版本校验**：

1. 把数据集复制到临时目录（基线保持只读、零改动）；
2. 在副本上应用修复计划并重新审计，要求残留问题为 0；
3. 将修复结果与基线逐字段 diff，**每一处变更都必须能追溯到某个已审计
   问题**（允许集合由问题的 term/doc/stat 实体推导），否则校验失败。

## 运行

```bash
python3.11 -m search_audit generate --out demo_data --docs 40 --seed 7
python3.11 -m search_audit corrupt  --data demo_data --seed 11   # 注入演示用腐坏
python3.11 -m search_audit audit    --data demo_data             # 只读审计
python3.11 -m search_audit fixplan  --data demo_data             # 修复计划 + 基线校验
python3.11 -m unittest discover -s tests -v                      # 测试
```

`audit` 发现问题时退出码为 1；`fixplan` 校验通过时退出码为 0。

## 示例输出（种子 11 的腐坏数据集）

```
audit found 17 issue(s) across 8 kind(s)
  DF_MISMATCH: 2 / MISSING_DOC_FILE: 1 / MISSING_LEXICON_ENTRY: 2
  MISSING_POSTING: 3 / ORPHAN_DOC_REFERENCE: 2 / ORPHAN_LEXICON_ENTRY: 2
  STALE_POSTING: 3 / STATS_MISMATCH: 2
  [ORPHAN_DOC_REFERENCE] doc=doc_0028 :: deleted doc referenced by 32 posting list(s) ...
status: INCONSISTENT

fix plan has 15 operation(s): purge_doc / add_posting / remove_doc_from_index /
  remove_posting / add_lexicon_entry / remove_lexicon_entry / recompute_df / recompute_stats
baseline validation: applied 15 op(s) on a scratch copy;
  residual issues: 0; unexpected changes vs baseline: 0
validation: PASS (baseline untouched, plan verified)
```

## 测试

`tests/` 下 21 个 unittest 用例：分词规则（含 CJK、casefold）、干净数据
集零问题、每类缺失/孤儿/计数差异的检出、孤儿引用去重（多个 posting 引
用只计一次）、审计只读性（逐字节快照对比）、修复后复审为零且基线未被
意外改动。
