# zpack 测试结果

## 运行命令

    python -m unittest discover -s tests -v

## 真实结果（2026-10-01，Python 3.14.4）

- 运行总数：19
- 通过：19
- 失败：0
- 错误：0
- 最终状态：OK

## 覆盖的验收点

- 空输入：`test_empty_input`、`test_empty_input_cli`（API 与 CLI roundtrip）
- 重复 abc 构造字典命中：`test_repeated_abc_dict_hit`（断言字典非空、含 >=128 的字典 token、token 数小于原始长度）
- 非最短 varint `0x80 0x00` 拒绝：`test_noncanonical_rejected`（FormatError）
- 第 5 字节高位非零 / 超 5 字节：`test_fifth_byte_high_bits_rejected`、`test_over_five_bytes_rejected`
- 声明上限 10 实际输出 11：`test_declared_limit_exceeded_no_output`（BudgetError）、`test_declared_limit_exceeded_cli_atomic`（exit 6 且无输出文件）
- 字典索引越界：`test_dict_index_out_of_range`（FormatError）
- 预算预检：`test_budget_checked_before_decode`（声明超过预算即 BudgetError，不解码）
- 最优性对照：`test_random_samples_match_brute_force`（60 个长度 <=120 随机样本，与暴力枚举所有字典选择的最短 token 数逐一相等）
- 并列选最小字典索引：`test_tie_break_smallest_index`
- CLI roundtrip 原子写：`test_roundtrip_atomic_write`；失败 exit 6：`test_missing_input_exit_6`

## 格式说明

- 头：u32be 字典条数 D；随后 D 条 u16be 长度 + 字节
- 之后：规范 varint 声明解压大小（7 位一组，最长 5 字节，拒绝非最短与第 5 字节高位非零）
- token 流：0..127 字面量，128..255 字典索引减 128
- 解码前检查声明大小是否超过预算；解码中输出超过声明即 BudgetError；结束时长度不等于声明即 FormatError
- CLI：`python -m zpack encode|decode INPUT OUTPUT [--max-output N]`，输出经临时文件 + os.replace 原子写入，任何失败 exit 6 且不产生输出文件
