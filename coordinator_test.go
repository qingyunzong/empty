package formal

import (
	"testing"
	"time"
)

var testBase = time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)

func at(ms int) time.Time { return testBase.Add(time.Duration(ms) * time.Millisecond) }

func testConfig() Config {
	cfg := DefaultConfig()
	cfg.MinHistorySamples = 4
	cfg.DefaultResource = ResourceSpec{CPUMillis: 1000, MemoryMB: 512}
	return cfg
}

func countTypes(events []Event) map[EventType]int {
	m := make(map[EventType]int)
	for _, ev := range events {
		m[ev.Type]++
	}
	return m
}

func findEvent(events []Event, typ EventType) (Event, bool) {
	for _, ev := range events {
		if ev.Type == typ {
			return ev, true
		}
	}
	return Event{}, false
}

func TestQuantileNearestRank(t *testing.T) {
	samples := []time.Duration{10, 20, 30, 40, 50, 60, 70, 80, 90, 100}
	cases := []struct {
		q    float64
		want time.Duration
	}{
		{0.5, 50},
		{0.9, 90},
		{0.99, 100},
		{1, 100},
	}
	for _, tc := range cases {
		if got := Quantile(samples, tc.q); got != tc.want {
			t.Fatalf("Quantile(%v) = %v, want %v", tc.q, got, tc.want)
		}
	}
	if got := Quantile(nil, 0.9); got != 0 {
		t.Fatalf("Quantile(empty) = %v, want 0", got)
	}
	// 最近秩向上取整：n=4、p90 -> rank=ceil(3.6)=4，取最大值。
	if got := Quantile([]time.Duration{1, 2, 3, 4}, 0.9); got != 4 {
		t.Fatalf("Quantile(n=4,p90) = %v, want 4", got)
	}
}

func TestSlowThresholdRequiresHistory(t *testing.T) {
	cfg := testConfig()
	if got := slowThreshold([]time.Duration{1, 2, 3}, cfg); got != 0 {
		t.Fatalf("slowThreshold with insufficient history = %v, want 0", got)
	}
	history := []time.Duration{
		10 * time.Millisecond, 20 * time.Millisecond, 30 * time.Millisecond, 40 * time.Millisecond,
		50 * time.Millisecond, 60 * time.Millisecond, 70 * time.Millisecond, 80 * time.Millisecond,
		90 * time.Millisecond, 100 * time.Millisecond,
	}
	if got := slowThreshold(history, cfg); got != 90*time.Millisecond {
		t.Fatalf("slowThreshold = %v, want 90ms", got)
	}
}

// TestSpeculationAndUniqueCommit 建立 4 个成功历史，验证 p90 之后才启动
// 有限推测副本，首个有效结果提交后其余尝试被撤销，且分区只提交一次。
func TestSpeculationAndUniqueCommit(t *testing.T) {
	c := NewCoordinator(testConfig())
	res := ResourceSpec{CPUMillis: 2000, MemoryMB: 256}

	// 先只注册 e1，预热任务都落在 e1；e2 留给推测副本。
	c.RegisterExecutor("e1", at(0))
	// e2 预先注册但保持空闲，避免晚于历史事件注册造成事件时间倒流。
	c.RegisterExecutor("e2", at(0))

	// 4 个成功样本，运行时长 10/20/30/40ms，p90 = 40ms。
	for i := 0; i < 4; i++ {
		tid := TaskID("warm-" + string(rune('a'+i)))
		part := ShufflePartition("p-warm-" + string(rune('a'+i)))
		start := at(100 * i)
		c.SubmitTask(TaskSpec{ID: tid, Partition: part, Resource: res}, start)
		c.Tick(start.Add(1 * time.Millisecond))
		c.AttemptSucceeded(Result{
			TaskID: tid, AttemptID: AttemptID(tid + "#1"), Executor: "e1", Payload: "ok",
		}, start.Add(time.Duration(10*(i+1))*time.Millisecond))
	}
	if got := slowThreshold(c.History(), c.cfg); got != 40*time.Millisecond {
		t.Fatalf("p90 threshold = %v, want 40ms", got)
	}

	slowStart := at(400)
	c.SubmitTask(TaskSpec{ID: "slow", Partition: "p-slow", Resource: res}, slowStart)
	original := AttemptID("slow#1")

	// 39ms 未达 p90，不得推测。
	c.Tick(slowStart.Add(39 * time.Millisecond))
	if c.findAttempt("slow", "slow#2") != nil {
		t.Fatal("speculative copy started before p90 threshold")
	}
	// 40ms 达到阈值，启动唯一推测副本。
	c.Tick(slowStart.Add(40 * time.Millisecond))
	spec := c.findAttempt("slow", "slow#2")
	if spec == nil || spec.kind != AttemptSpeculative {
		t.Fatalf("expected speculative attempt at p90, got %+v", spec)
	}
	if c.findAttempt("slow", "slow#3") != nil {
		t.Fatal("speculation must respect MaxAttempts and idle-executor limits")
	}

	// 推测副本先成功：提交分区，原尝试被撤销。
	c.AttemptSucceeded(Result{
		TaskID: "slow", AttemptID: "slow#2", Executor: "e2", Payload: "ok",
	}, slowStart.Add(50*time.Millisecond))
	task := c.tasks["slow"]
	if !task.committed || task.committedBy != "slow#2" {
		t.Fatalf("commit state = committed(%v) by %q", task.committed, task.committedBy)
	}
	if task.attempts[0].running || task.attempts[0].terminal != EvAttemptCancelled {
		t.Fatal("original attempt must be cancelled after first valid commit")
	}

	// 原尝试晚到成功：必须拒绝，分区不得二次发布。
	rejected := c.AttemptSucceeded(Result{
		TaskID: "slow", AttemptID: original, Executor: "e1", Payload: "late",
	}, slowStart.Add(60*time.Millisecond))
	if len(rejected) != 1 || rejected[0].Type != EvResultRejected ||
		rejected[0].Reason != RejectTaskAlreadyCommitted {
		t.Fatalf("late success not rejected: %+v", rejected)
	}

	counts := countTypes(c.Events())
	if counts[EvPartitionCommitted] != 5 {
		t.Fatalf("partition commits = %d, want 5", counts[EvPartitionCommitted])
	}
	commits := map[ShufflePartition]int{}
	for _, ev := range c.Events() {
		if ev.Type == EvPartitionCommitted {
			commits[ev.Partition]++
		}
	}
	for p, n := range commits {
		if n != 1 {
			t.Fatalf("partition %s committed %d times", p, n)
		}
	}

	report := c.Replay()
	if !report.OK() {
		t.Fatalf("replay violations: %v", report.Violations)
	}
	if len(report.CommittedPartitions) != 5 {
		t.Fatalf("replay committed partitions = %d, want 5", len(report.CommittedPartitions))
	}
}

// TestExecutorLossAndRetry 验证执行器丢失不会导致分区重复发布，
// 任务在其他执行器上重试并最终提交，资源台账全程守恒。
func TestExecutorLossAndRetry(t *testing.T) {
	c := NewCoordinator(testConfig())
	res := ResourceSpec{CPUMillis: 500, MemoryMB: 128}
	c.RegisterExecutor("e1", at(0))
	c.RegisterExecutor("e2", at(0))
	c.SubmitTask(TaskSpec{ID: "t", Partition: "p", Resource: res}, at(0))

	first := c.findAttempt("t", "t#1")
	if first == nil || first.executor != "e1" {
		t.Fatalf("first attempt = %+v, want on e1", first)
	}

	c.Tick(at(10))
	lost := c.ExecutorLost("e1", at(20))
	if ev, ok := findEvent(lost, EvExecutorLost); !ok || ev.ExecutorID != "e1" {
		t.Fatalf("missing executor-lost event: %+v", lost)
	}
	if first.running || first.terminal != EvAttemptFailed {
		t.Fatal("lost executor's attempt must fail")
	}

	// 丢失执行器上的晚到成功必须拒绝。
	rejected := c.AttemptSucceeded(Result{
		TaskID: "t", AttemptID: "t#1", Executor: "e1", Payload: "late",
	}, at(25))
	if len(rejected) != 1 || rejected[0].Reason != RejectAttemptNotRunning {
		t.Fatalf("late success on lost executor not rejected correctly: %+v", rejected)
	}

	// e2 接管重试并成功，分区仅提交一次。
	retry := c.findAttempt("t", "t#2")
	if retry == nil || retry.kind != AttemptRetry || retry.executor != "e2" {
		t.Fatalf("retry attempt = %+v", retry)
	}
	c.Tick(at(30))
	c.AttemptSucceeded(Result{
		TaskID: "t", AttemptID: "t#2", Executor: "e2", Payload: "ok",
	}, at(40))

	counts := countTypes(c.Events())
	if counts[EvPartitionCommitted] != 1 {
		t.Fatalf("partition commits = %d, want 1", counts[EvPartitionCommitted])
	}
	if c.ResourceHold() != (ResourceSpec{}) {
		t.Fatalf("resource hold after completion = %+v, want zero", c.ResourceHold())
	}

	report := c.Replay()
	if !report.OK() {
		t.Fatalf("replay violations: %v", report.Violations)
	}
	if report.Placed != report.Released {
		t.Fatalf("billing not conserved: placed=%+v released=%+v", report.Placed, report.Released)
	}
	want := res.Add(res)
	if report.Placed != want {
		t.Fatalf("placed = %+v, want %+v", report.Placed, want)
	}
	// t#1 计费 20ms（0..10、10..20），t#2 计费 20ms（20..30、30..40）。
	wantBilled := res.CPUMillis * 40 * time.Millisecond.Nanoseconds()
	if report.Billed.CPUMillisNanos != wantBilled {
		t.Fatalf("billed CPU = %d, want %d", report.Billed.CPUMillisNanos, wantBilled)
	}
}

// TestNoPrematureJudgement 验证历史不足时不做任何推测或超时判定，
// 慢任务可以一直运行而不被过早杀死。
func TestNoPrematureJudgement(t *testing.T) {
	c := NewCoordinator(testConfig())
	c.RegisterExecutor("e1", at(0))
	c.SubmitTask(TaskSpec{ID: "slow", Partition: "p-slow"}, at(0))

	// 远超任何合理时长，但没有历史样本：既不推测也不超时。
	c.Tick(at(1_000_000))
	att := c.findAttempt("slow", "slow#1")
	if att == nil || !att.running {
		t.Fatal("slow task must keep running without history")
	}
	if c.findAttempt("slow", "slow#2") != nil {
		t.Fatal("no speculation allowed without sufficient history")
	}
	counts := countTypes(c.Events())
	if counts[EvAttemptTimedOut] != 0 || counts[EvAttemptCancelled] != 0 {
		t.Fatal("slow task was judged prematurely")
	}

	c.AttemptSucceeded(Result{
		TaskID: "slow", AttemptID: "slow#1", Executor: "e1", Payload: "ok",
	}, at(1_000_100))
	report := c.Replay()
	if !report.OK() {
		t.Fatalf("replay violations: %v", report.Violations)
	}
}

// TestHardTimeoutOnlyAfterQuantile 验证启用硬超时后，也必须等到
// TimeoutMultiplier × 超时分位数之后才判定，阈值之前不允许超时事件。
func TestHardTimeoutOnlyAfterQuantile(t *testing.T) {
	cfg := testConfig()
	cfg.TimeoutMultiplier = 2
	cfg.MaxAttempts = 1
	c := NewCoordinator(cfg)
	res := ResourceSpec{CPUMillis: 100, MemoryMB: 64}
	c.RegisterExecutor("e1", at(0))

	// 4 个 100ms 样本：p99 = 100ms，硬超时 = 200ms。
	for i := 0; i < 4; i++ {
		tid := TaskID("warm-" + string(rune('a'+i)))
		part := ShufflePartition("pw-" + string(rune('a'+i)))
		start := at(200 * i)
		c.SubmitTask(TaskSpec{ID: tid, Partition: part, Resource: res}, start)
		c.AttemptSucceeded(Result{
			TaskID: tid, AttemptID: AttemptID(tid + "#1"), Executor: "e1", Payload: "ok",
		}, start.Add(100*time.Millisecond))
	}

	stuckStart := at(1000)
	c.SubmitTask(TaskSpec{ID: "stuck", Partition: "p-stuck", Resource: res}, stuckStart)
	c.Tick(stuckStart.Add(199 * time.Millisecond))
	if c.findAttempt("stuck", "stuck#1").terminal != 0 {
		t.Fatal("timeout fired before hard-timeout threshold")
	}
	c.Tick(stuckStart.Add(200 * time.Millisecond))
	att := c.findAttempt("stuck", "stuck#1")
	if att.running || att.terminal != EvAttemptTimedOut {
		t.Fatalf("expected timeout at threshold, got running=%v terminal=%v", att.running, att.terminal)
	}
	// 配额为 1：超时即任务失败，分区绝不提交。
	task := c.tasks["stuck"]
	if !task.failed || task.committed {
		t.Fatalf("task state failed=%v committed=%v, want failed only", task.failed, task.committed)
	}
	if countTypes(c.Events())[EvPartitionCommitted] != 4 {
		t.Fatal("timed-out task must not commit its partition")
	}
	report := c.Replay()
	if !report.OK() {
		t.Fatalf("replay violations: %v", report.Violations)
	}
}

// TestInvalidResultRejected 验证校验失败的结果不会提交分区，
// 尝试按失败处理并可在其他执行器上重试。
func TestInvalidResultRejected(t *testing.T) {
	cfg := testConfig()
	cfg.Validate = func(_ TaskID, payload string) bool { return payload == "valid" }
	c := NewCoordinator(cfg)
	c.RegisterExecutor("e1", at(0))
	c.RegisterExecutor("e2", at(0))
	c.SubmitTask(TaskSpec{ID: "t", Partition: "p"}, at(0))

	evs := c.AttemptSucceeded(Result{
		TaskID: "t", AttemptID: "t#1", Executor: "e1", Payload: "bogus",
	}, at(10))
	if evs[0].Type != EvResultRejected || evs[0].Reason != RejectValidationFailed {
		t.Fatalf("invalid result not rejected: %+v", evs)
	}
	if c.IsCommitted("p") {
		t.Fatal("invalid result must not commit the partition")
	}
	if c.findAttempt("t", "t#1").running {
		t.Fatal("rejected attempt must be terminated for retry")
	}

	retry := c.findAttempt("t", "t#2")
	if retry == nil || retry.kind != AttemptRetry || !retry.running {
		t.Fatalf("expected running retry, got %+v", retry)
	}
	c.AttemptSucceeded(Result{
		TaskID: "t", AttemptID: retry.id, Executor: retry.executor, Payload: "valid",
	}, at(20))
	if !c.IsCommitted("p") {
		t.Fatal("valid retry result must commit the partition")
	}
	if countTypes(c.Events())[EvPartitionCommitted] != 1 {
		t.Fatal("partition must commit exactly once")
	}
	if !c.Replay().OK() {
		t.Fatalf("replay violations: %v", c.Replay().Violations)
	}
}

// TestTaskFailsAfterAttemptBudget 验证尝试配额耗尽后任务失败且不提交分区。
func TestTaskFailsAfterAttemptBudget(t *testing.T) {
	cfg := testConfig()
	cfg.MaxAttempts = 2
	c := NewCoordinator(cfg)
	c.RegisterExecutor("e1", at(0))
	c.RegisterExecutor("e2", at(0))
	c.SubmitTask(TaskSpec{ID: "t", Partition: "p"}, at(0))

	c.ExecutorLost("e1", at(10))
	c.ExecutorLost("e2", at(20))

	task := c.tasks["t"]
	if !task.failed || task.committed {
		t.Fatalf("task state failed=%v committed=%v, want failed only", task.failed, task.committed)
	}
	if countTypes(c.Events())[EvTaskFailed] != 1 {
		t.Fatal("expected exactly one task-failed event")
	}
	if c.ResourceHold() != (ResourceSpec{}) {
		t.Fatalf("hold = %+v, want zero after failure", c.ResourceHold())
	}
	report := c.Replay()
	if !report.OK() {
		t.Fatalf("replay violations: %v", report.Violations)
	}
}
