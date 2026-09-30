# posidx 验收结果

环境：Python 3.14.4（代码兼容 3.11，仅标准库），Linux。
所有命令均在仓库根目录执行，真实输出如下。

## 1. 单元测试

命令：

    python -m unittest discover -s tests -v

输出（末尾摘要，完整 21 项全部 ok）：

    test_and_or_not (test_posidx.TestA_RandomizedVsNaive.test_and_or_not) ... ok
    test_mixed (test_posidx.TestA_RandomizedVsNaive.test_mixed) ... ok
    test_phrases (test_posidx.TestA_RandomizedVsNaive.test_phrases) ... ok
    test_single_terms (test_posidx.TestA_RandomizedVsNaive.test_single_terms) ... ok
    test_old_terms_not_searchable (test_posidx.TestB_ReingestReplaces.test_old_terms_not_searchable) ... ok
    test_positions_reset_after_replace (test_posidx.TestB_ReingestReplaces.test_positions_reset_after_replace) ... ok
    test_postings_do_not_leak (test_posidx.TestB_ReingestReplaces.test_postings_do_not_leak) ... ok
    test_delete_and_reload (test_posidx.TestC_DeletePersistReload.test_delete_and_reload) ... ok
    test_deleted_docs_absent_from_all_results (test_posidx.TestC_DeletePersistReload.test_deleted_docs_absent_from_all_results) ... ok
    test_save_load_roundtrip_equality (test_posidx.TestC_DeletePersistReload.test_save_load_roundtrip_equality) ... ok
    test_bad_jsonl_lines_exit_2_and_skip (test_posidx.TestD_CliExitCodes.test_bad_jsonl_lines_exit_2_and_skip) ... ok
    test_clean_ingest_exit_0 (test_posidx.TestD_CliExitCodes.test_clean_ingest_exit_0) ... ok
    test_corrupt_manifest_exit_4 (test_posidx.TestD_CliExitCodes.test_corrupt_manifest_exit_4) ... ok
    test_delete_noop_exit_0 (test_posidx.TestD_CliExitCodes.test_delete_noop_exit_0) ... ok
    test_empty_query_exit_3 (test_posidx.TestD_CliExitCodes.test_empty_query_exit_3) ... ok
    test_missing_index_exit_4 (test_posidx.TestD_CliExitCodes.test_missing_index_exit_4) ... ok
    test_no_results_exit_0_empty_array (test_posidx.TestD_CliExitCodes.test_no_results_exit_0_empty_array) ... ok
    test_tampered_index_exit_4 (test_posidx.TestD_CliExitCodes.test_tampered_index_exit_4) ... ok
    test_syntax_errors_raise (test_posidx.TestQuerySyntax.test_syntax_errors_raise) ... ok
    test_valid_queries (test_posidx.TestQuerySyntax.test_valid_queries) ... ok
    test_lowercase_alnum_runs (test_posidx.TestTokenizer.test_lowercase_alnum_runs) ... ok

    ----------------------------------------------------------------------
    Ran 21 tests in 1.062s

    OK

覆盖验收点：
- A `TestA_RandomizedVsNaive`：200 篇随机文档，AND/OR/NOT/短语与朴素扫描逐条对照。
- B `TestB_ReingestReplaces`：同 id 重复 ingest 后旧词不可命中、位置重置、postings 无泄漏。
- C `TestC_DeletePersistReload`：删除后 save/load，查询结果与内存索引一致，已删文档不出现在任何结果。
- D `TestD_CliExitCodes`：坏行 exit 2、空查询/语法错 exit 3、损坏 manifest/篡改索引 exit 4、无结果 exit 0 输出 `[]`。

## 2. CLI 冒烟（三条）

准备 `/tmp/posidx-smoke/docs.jsonl`：

    {"id": "d1", "text": "The quick brown fox jumps over the lazy dog"}
    {"id": "d2", "text": "Quick brown bears eat honey, and foxes nap"}
    {"id": "d3", "text": "Lazy dogs and quick cats"}

冒烟 1 — ingest：

    $ python -m posidx ingest ./idx docs.jsonl
    ingested 3 document(s), skipped 0 bad line(s)
    exit=0

冒烟 2 — 短语 + NOT 查询：

    $ python -m posidx query ./idx '"quick brown" AND NOT bears'
    ["d1"]
    exit=0

冒烟 3 — 删除后再查询（验证删除持久化生效）：

    $ python -m posidx delete ./idx d1
    deleted 'd1'
    exit=0
    $ python -m posidx query ./idx 'quick AND lazy'
    ["d3"]
    exit=0

说明：冒烟 3 中 `d1` 已被删除故不命中；`d2` 含 quick 但无 lazy；仅 `d3` 同时含两词，结果正确。
