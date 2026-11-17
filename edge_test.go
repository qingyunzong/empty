package formal

import "testing"

func TestRejectionReasonsAndAccessors(t *testing.T) {
	c := NewCoordinator(testConfig())
	c.RegisterExecutor("e1", at(0))
	c.SubmitTask(TaskSpec{ID: "t", Partition: "p"}, at(0))

	// 未知尝试与执行器不匹配都必须被拒绝。
	if evs := c.AttemptSucceeded(Result{
		TaskID: "t", AttemptID: "ghost", Executor: "e1",
	}, at(5)); evs[0].Reason != RejectUnknownAttempt {
		t.Fatalf("unknown attempt reason = %v", evs[0].Reason)
	}
	if evs := c.AttemptSucceeded(Result{
		TaskID: "t", AttemptID: "t#1", Executor: "other",
	}, at(5)); evs[0].Reason != RejectExecutorMismatch {
		t.Fatalf("executor mismatch reason = %v", evs[0].Reason)
	}

	c.Tick(at(10))
	if c.BilledUsage().CPUMillisNanos <= 0 {
		t.Fatal("expected positive billed usage after tick")
	}

	c.AttemptSucceeded(Result{
		TaskID: "t", AttemptID: "t#1", Executor: "e1", Payload: "ok",
	}, at(20))
	if !c.IsCommitted("p") {
		t.Fatal("partition should be committed")
	}
	// 已终结尝试再次回报：拒绝且不产生新提交。
	if evs := c.AttemptSucceeded(Result{
		TaskID: "t", AttemptID: "t#1", Executor: "e1", Payload: "dup",
	}, at(30)); evs[0].Reason != RejectTaskAlreadyCommitted {
		t.Fatalf("post-commit reason = %v", evs[0].Reason)
	}
	if !c.Replay().OK() {
		t.Fatalf("replay violations: %v", c.Replay().Violations)
	}
}

func TestIdempotentRegistrationAndUnknownLoss(t *testing.T) {
	c := NewCoordinator(testConfig())
	c.RegisterExecutor("e1", at(0))
	c.RegisterExecutor("e1", at(1)) // 重复注册必须幂等
	if len(c.execs) != 1 || countTypes(c.Events())[EvExecutorRegistered] != 1 {
		t.Fatal("duplicate executor registration must be ignored")
	}
	// 未知执行器丢失与重复丢失均为安全空操作。
	if evs := c.ExecutorLost("ghost", at(2)); len(evs) != 0 {
		t.Fatalf("unknown executor loss should be a no-op, got %+v", evs)
	}
	c.ExecutorLost("e1", at(3))
	if evs := c.ExecutorLost("e1", at(4)); len(evs) != 0 {
		t.Fatalf("duplicate executor loss should be a no-op, got %+v", evs)
	}
}

func TestAttemptFailedThenRetry(t *testing.T) {
	c := NewCoordinator(testConfig())
	c.RegisterExecutor("e1", at(0))
	c.RegisterExecutor("e2", at(0))
	c.SubmitTask(TaskSpec{ID: "t", Partition: "p"}, at(0))

	// 对未知/已终结尝试的失败回报是空操作。
	if evs := c.AttemptFailed("t", "ghost", at(5)); len(evs) != 0 {
		t.Fatalf("unknown attempt failure must be no-op, got %+v", evs)
	}
	c.AttemptFailed("t", "t#1", at(10))
	if c.findAttempt("t", "t#1").terminal != EvAttemptFailed {
		t.Fatal("first attempt must be failed")
	}
	retry := c.findAttempt("t", "t#2")
	if retry == nil || retry.kind != AttemptRetry {
		t.Fatalf("expected retry, got %+v", retry)
	}
	c.AttemptSucceeded(Result{
		TaskID: "t", AttemptID: retry.id, Executor: retry.executor, Payload: "ok",
	}, at(20))
	if !c.IsCommitted("p") || !c.Replay().OK() {
		t.Fatal("task should commit once and replay cleanly")
	}
}
