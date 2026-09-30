# posidx — 真实运行结果

环境：容器内仅有 `python3`（Python 3.14.4，仅用标准库，代码兼容 3.11）。
为按题目要求使用 `python` 命令，建立了符号链接
`ln -sf /usr/bin/python3 /tmp/pybin/python` 并执行 `export PATH=/tmp/pybin:$PATH`。

## 1. 单元测试

命令：

    python -m unittest discover -s tests -v

真实输出：

    test_random_corpus_matches_naive_scan (test_posidx.AcceptanceA.test_random_corpus_matches_naive_scan) ... ok
    test_old_terms_do_not_hit_after_reingest (test_posidx.AcceptanceB.test_old_terms_do_not_hit_after_reingest) ... ok
    test_reingest_identical_text_is_stable (test_posidx.AcceptanceB.test_reingest_identical_text_is_stable) ... ok
    test_delete_is_noop_for_missing_id (test_posidx.AcceptanceC.test_delete_is_noop_for_missing_id) ... ok
    test_deleted_docs_never_match (test_posidx.AcceptanceC.test_deleted_docs_never_match) ... ok
    test_save_load_roundtrip_matches_memory (test_posidx.AcceptanceC.test_save_load_roundtrip_matches_memory) ... ok
    test_bad_jsonl_lines_exit_2_and_are_skipped (test_posidx.AcceptanceD.test_bad_jsonl_lines_exit_2_and_are_skipped) ... ok
    test_corrupt_manifest_exits_4 (test_posidx.AcceptanceD.test_corrupt_manifest_exits_4) ... ok
    test_delete_nonexistent_id_is_noop_exit_0 (test_posidx.AcceptanceD.test_delete_nonexistent_id_is_noop_exit_0) ... ok
    test_empty_and_broken_queries_exit_3 (test_posidx.AcceptanceD.test_empty_and_broken_queries_exit_3) ... ok
    test_no_results_exit_0_empty_array (test_posidx.AcceptanceD.test_no_results_exit_0_empty_array) ... ok
    test_operators_are_case_insensitive (test_posidx.QuerySyntaxTest.test_operators_are_case_insensitive) ... ok
    test_phrase_requires_consecutive_positions (test_posidx.QuerySyntaxTest.test_phrase_requires_consecutive_positions) ... ok
    test_precedence_not_and_or (test_posidx.QuerySyntaxTest.test_precedence_not_and_or) ... ok
    test_positions_count_tokens_only (test_posidx.TokenizeTest.test_positions_count_tokens_only) ... ok
    test_unicode_lowercase_alnum_runs (test_posidx.TokenizeTest.test_unicode_lowercase_alnum_runs) ... ok

    ----------------------------------------------------------------------
    Ran 16 tests in 0.995s

    OK

## 2. CLI 冒烟（三条）

输入文件 `/tmp/smoke_run1/docs.jsonl`：

    {"id": "d1", "text": "The quick brown fox jumps over the lazy dog"}
    {"id": "d2", "text": "Quick brown squirrels are quick and brown"}
    {"id": "d3", "text": "Unicode cafe naive tokens, CAFE again!"}

### 冒烟 1：ingest

    $ python -m posidx ingest /tmp/smoke_run1/idx /tmp/smoke_run1/docs.jsonl
    ingested into /tmp/smoke_run1/idx: 3 document(s)
    exit=0

### 冒烟 2：query（短语 + 布尔）

    $ python -m posidx query /tmp/smoke_run1/idx '"quick brown" AND NOT squirrels'
    ["d1"]
    exit=0

### 冒烟 3：delete（随后验证查询结果）

    $ python -m posidx delete /tmp/smoke_run1/idx d1
    deleted 'd1'
    exit=0

验证（删除已持久化，d1 不再出现；大小写折叠生效）：

    $ python -m posidx query /tmp/smoke_run1/idx 'quick'
    ["d2"]
    exit=0
    $ python -m posidx query /tmp/smoke_run1/idx 'cafe'
    ["d3"]
    exit=0

## 3. 退出码契约（由 tests/test_posidx.py 中 AcceptanceD 自动断言）

- JSONL 坏行：exit 2，坏行跳过、好行仍入库
- 空查询 / 语法错误查询：exit 3
- manifest 损坏 / 格式或版本不符 / docs.json 缺失：exit 4
- 查询无结果：exit 0，输出 `[]`
