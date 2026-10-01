# zpack 测试结果

- 命令: `python -m unittest discover -s tests -v`
- 日期: 2026-10-01 14:22:22 CST
- Python: Python 3.14.4
- 结果: **26 通过, 0 失败, 0 错误** (OK)

## 完整输出

```
test_bomb_aborts_before_writing (test_zpack.BudgetTests.test_bomb_aborts_before_writing) ... ok
test_budget_error_carries_no_output (test_zpack.BudgetTests.test_budget_error_carries_no_output) ... ok
test_declared_limit_exceeded (test_zpack.BudgetTests.test_declared_limit_exceeded) ... ok
test_cli_budget_failure_exit6_no_file (test_zpack.CliTests.test_cli_budget_failure_exit6_no_file) ... ok
test_cli_format_failure_exit6_no_file (test_zpack.CliTests.test_cli_format_failure_exit6_no_file) ... ok
test_cli_missing_input_exit6 (test_zpack.CliTests.test_cli_missing_input_exit6) ... ok
test_cli_roundtrip (test_zpack.CliTests.test_cli_roundtrip) ... ok
test_cli_roundtrip_empty (test_zpack.CliTests.test_cli_roundtrip_empty) ... ok
test_dictionary_index_out_of_range (test_zpack.FormatTests.test_dictionary_index_out_of_range) ... ok
test_empty_input_roundtrip (test_zpack.FormatTests.test_empty_input_roundtrip) ... ok
test_entry_length_u16_limit (test_zpack.FormatTests.test_entry_length_u16_limit) ... ok
test_nonminimal_varint_header_rejected (test_zpack.FormatTests.test_nonminimal_varint_header_rejected) ... ok
test_repeated_abc_dictionary_hit (test_zpack.FormatTests.test_repeated_abc_dictionary_hit) ... ok
test_truncated_entry_rejected (test_zpack.FormatTests.test_truncated_entry_rejected) ... ok
test_truncated_stream_rejected (test_zpack.FormatTests.test_truncated_stream_rejected) ... ok
test_high_bytes_encoded_via_dictionary (test_zpack.OptimalParseTests.test_high_bytes_encoded_via_dictionary) ... ok
test_random_samples_against_brute_force (test_zpack.OptimalParseTests.test_random_samples_against_brute_force) ... ok
test_structured_samples_against_brute_force (test_zpack.OptimalParseTests.test_structured_samples_against_brute_force) ... ok
test_tie_break_prefers_smallest_index (test_zpack.OptimalParseTests.test_tie_break_prefers_smallest_index) ... ok
test_fifth_byte_high_bits_rejected (test_zpack.VarintTests.test_fifth_byte_high_bits_rejected) ... ok
test_known_encodings (test_zpack.VarintTests.test_known_encodings) ... ok
test_non_shortest_rejected (test_zpack.VarintTests.test_non_shortest_rejected) ... ok
test_out_of_range_value (test_zpack.VarintTests.test_out_of_range_value) ... ok
test_overlong_varint_rejected (test_zpack.VarintTests.test_overlong_varint_rejected) ... ok
test_roundtrip_boundaries (test_zpack.VarintTests.test_roundtrip_boundaries) ... ok
test_truncated_varint_rejected (test_zpack.VarintTests.test_truncated_varint_rejected) ... ok

----------------------------------------------------------------------
Ran 26 tests in 5.289s

OK
```
