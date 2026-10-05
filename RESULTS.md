# 测试结果记录

- 日期: 2026-10-05 20:08:27 CST
- 工具链: g++ (Ubuntu 15.2.0-16ubuntu1) 15.2.0, cmake version 4.2.3, Python 3.14.4
- 命令: `cmake -S . -B build && cmake --build build && cd build && ctest`

```
Test project /home/delin/.local/share/gsb-workbench/artifacts/12418b81cac4448bb07fd660c885cb98/run/B/attempt-004/workspace/build
      Start  1: unit
 1/20 Test  #1: unit .............................   Passed    0.00 sec
      Start  2: gen_fixtures
 2/20 Test  #2: gen_fixtures .....................   Passed    0.01 sec
      Start  3: check_valid_basic
 3/20 Test  #3: check_valid_basic ................   Passed    0.06 sec
      Start  4: check_valid_shared
 4/20 Test  #4: check_valid_shared ...............   Passed    0.06 sec
      Start  5: check_valid_zero_length
 5/20 Test  #5: check_valid_zero_length ..........   Passed    0.04 sec
      Start  6: check_valid_extreme_end
 6/20 Test  #6: check_valid_extreme_end ..........   Passed    0.04 sec
      Start  7: check_valid_empty
 7/20 Test  #7: check_valid_empty ................   Passed    0.04 sec
      Start  8: check_invalid_end_overflow
 8/20 Test  #8: check_invalid_end_overflow .......   Passed    0.06 sec
      Start  9: check_invalid_len_max
 9/20 Test  #9: check_invalid_len_max ............   Passed    0.06 sec
      Start 10: check_invalid_offset_max_len1
10/20 Test #10: check_invalid_offset_max_len1 ....   Passed    0.06 sec
      Start 11: check_invalid_partial_overlap
11/20 Test #11: check_invalid_partial_overlap ....   Passed    0.05 sec
      Start 12: check_invalid_containment
12/20 Test #12: check_invalid_containment ........   Passed    0.05 sec
      Start 13: check_invalid_shared_prefix
13/20 Test #13: check_invalid_shared_prefix ......   Passed    0.05 sec
      Start 14: check_bad_magic
14/20 Test #14: check_bad_magic ..................   Passed    0.05 sec
      Start 15: check_truncated_header
15/20 Test #15: check_truncated_header ...........   Passed    0.04 sec
      Start 16: check_truncated_entries
16/20 Test #16: check_truncated_entries ..........   Passed    0.05 sec
      Start 17: check_trailing_bytes
17/20 Test #17: check_trailing_bytes .............   Passed    0.04 sec
      Start 18: check_count_huge
18/20 Test #18: check_count_huge .................   Passed    0.04 sec
      Start 19: check_view_ok
19/20 Test #19: check_view_ok ....................   Passed    0.04 sec
      Start 20: check_view_exceeds
20/20 Test #20: check_view_exceeds ...............   Passed    0.04 sec

100% tests passed, 0 tests failed out of 20

Total Test time (real) =   0.90 sec
```
