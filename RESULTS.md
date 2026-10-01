# colbit 测试结果

- 命令：`python -m unittest discover -s tests -v`
- 环境：Python 3.14.4（代码兼容 3.11 标准库，无第三方依赖）
- 日期：2026-10-01

## 汇总

- 运行：12
- 通过：12
- 失败：0
- 错误：0
- 结果：OK

## 明细（实际运行输出）

| 测试 | 结果 |
| --- | --- |
| BoundaryRoundtripTest.test_width_boundaries (w=1,7,9,32 往返) | ok |
| CliTest.test_create_select_info | ok |
| CliTest.test_select_column_subset | ok |
| CrcTest.test_crc_error_reports_column_2 (翻转第2列一位，iter_rows 报 column 2) | ok |
| CrcTest.test_select_subset_skips_unselected_corrupt_column | ok |
| EdgeCaseTest.test_batch_larger_than_rows | ok |
| EdgeCaseTest.test_declared_bits_exceed_capacity | ok |
| EdgeCaseTest.test_string_column_forbidden | ok |
| EdgeCaseTest.test_w0_stores_no_data_and_decodes_zeros | ok |
| EdgeCaseTest.test_zero_rows | ok |
| ReferenceComparisonTest.test_non_byte_aligned_total_bits | ok |
| ReferenceComparisonTest.test_random_against_bitwise_reference (R<=200 随机对照逐位参考打包器) | ok |

尾部输出：

```
Ran 12 tests in 1.931s

OK
```
