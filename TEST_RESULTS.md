# 真实测试结果

命令: `/home/delin/.local/bin/python3.11 -m unittest -v test_quorum`

解释器: Python 3.11.16

```
test_conflicting_vote_is_rejected (test_quorum.TestAcceptance.test_conflicting_vote_is_rejected) ... ok
test_duplicate_vote_returns_first_result (test_quorum.TestAcceptance.test_duplicate_vote_returns_first_result) ... ok
test_late_vote_after_completion_is_rejected (test_quorum.TestAcceptance.test_late_vote_after_completion_is_rejected)
Late votes after the final state: exit code 9, ledger unchanged. ... ok
test_second_success_vote_completes (test_quorum.TestAcceptance.test_second_success_vote_completes)
Q=2, N=3: the second SUCCESS vote converges immediately. ... ok
test_two_failure_votes_fail_and_compensate (test_quorum.TestAcceptance.test_two_failure_votes_fail_and_compensate)
N-Q+1 = 2 FAIL votes make success impossible -> FAILED + compensation. ... ok
test_crash_after_compensate_event_then_recover (test_quorum.TestCrashRecovery.test_crash_after_compensate_event_then_recover)
Q=3, N=5: crash mid-compensation; recovery finishes the remaining ones. ... ok
test_crash_after_final_event_then_recover (test_quorum.TestCrashRecovery.test_crash_after_final_event_then_recover)
Crash after COMPLETED is persisted but before cancels are written. ... ok
test_crash_after_vote_event_then_recover (test_quorum.TestCrashRecovery.test_crash_after_vote_event_then_recover)
Crash after the deciding vote: recovery converges and keeps exact counts. ... ok
test_recover_is_idempotent (test_quorum.TestCrashRecovery.test_recover_is_idempotent) ... ok
test_all_vote_sequences_match_reference_tally (test_quorum.TestReferenceEnumeration.test_all_vote_sequences_match_reference_tally)
Enumerate every vote sequence for N=3, Q=2 and compare the CLI ... ok

----------------------------------------------------------------------
Ran 10 tests in 11.729s

OK

reference enumeration: 120 vote steps cross-checked
```
