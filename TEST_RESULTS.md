# 真实测试结果

命令: `python3.11 -m unittest -v`（Python 3.11.16，运行时间: 2026-09-27 10:05:03 CST）

```
test_crash_after_compensate_event_then_recover (test_consensus.TestCrashRecovery.test_crash_after_compensate_event_then_recover) ... ok
test_crash_after_final_event_then_recover (test_consensus.TestCrashRecovery.test_crash_after_final_event_then_recover) ... ok
test_crash_after_vote_event_then_recover (test_consensus.TestCrashRecovery.test_crash_after_vote_event_then_recover) ... ok
test_conflicting_vote_rejected (test_consensus.TestDuplicateAndConflict.test_conflicting_vote_rejected) ... ok
test_duplicate_vote_returns_first_result (test_consensus.TestDuplicateAndConflict.test_duplicate_vote_returns_first_result) ... ok
test_two_fail_votes_fail_and_compensate (test_consensus.TestFailureAndCompensation.test_two_fail_votes_fail_and_compensate) ... ok
test_late_vote_after_failure_exit_9 (test_consensus.TestLateVote.test_late_vote_after_failure_exit_9) ... ok
test_late_vote_exit_9_and_ledger_unchanged (test_consensus.TestLateVote.test_late_vote_exit_9_and_ledger_unchanged) ... ok
test_second_success_vote_completes (test_consensus.TestQuorumCompletion.test_second_success_vote_completes) ... ok
test_enumeration_matches_reference (test_consensus.TestReferenceTallyEnumeration.test_enumeration_matches_reference) ... ok
test_double_start_rejected (test_consensus.TestValidation.test_double_start_rejected) ... ok
test_invalid_quorum_rejected (test_consensus.TestValidation.test_invalid_quorum_rejected) ... ok
test_unknown_participant_rejected (test_consensus.TestValidation.test_unknown_participant_rejected) ... ok

----------------------------------------------------------------------
Ran 13 tests in 5.740s

OK
```
