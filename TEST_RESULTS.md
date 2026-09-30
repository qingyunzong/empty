# 测试结果（真实运行）

命令：`python3 -m unittest discover -s tests -v`

Python：Python 3.14.4
日期：2026-09-30 20:33:29 CST

```
test_bad_record_dead_letter_and_continue (test_processor.ProcessorTestCase.test_bad_record_dead_letter_and_continue) ... ok
test_cli_end_to_end (test_processor.ProcessorTestCase.test_cli_end_to_end) ... ok
test_crash_after_checkpoint_then_recover (test_processor.ProcessorTestCase.test_crash_after_checkpoint_then_recover) ... ok
test_crash_after_read_then_recover (test_processor.ProcessorTestCase.test_crash_after_read_then_recover) ... ok
test_crash_after_write_then_recover (test_processor.ProcessorTestCase.test_crash_after_write_then_recover) ... ok
test_duplicate_id_not_overwritten (test_processor.ProcessorTestCase.test_duplicate_id_not_overwritten) ... ok
test_empty_input_completes (test_processor.ProcessorTestCase.test_empty_input_completes) ... ok
test_explicit_errors (test_processor.ProcessorTestCase.test_explicit_errors) ... ok
test_normal_run_ten_records (test_processor.ProcessorTestCase.test_normal_run_ten_records) ... ok
test_recovery_detects_checkpoint_inconsistency (test_processor.ProcessorTestCase.test_recovery_detects_checkpoint_inconsistency) ... ok

----------------------------------------------------------------------
Ran 10 tests in 0.637s

OK
```
