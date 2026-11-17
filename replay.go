package formal

import (
	"fmt"
	"time"
)

// ReplayReport 汇总一次事件重放的重建结果与不变量校验结论。
type ReplayReport struct {
	// CommittedPartitions 是每个已提交分区到获胜尝试的映射。
	CommittedPartitions map[ShufflePartition]AttemptID
	// CommittedTasks 是已提交任务的集合。
	CommittedTasks map[TaskID]struct{}
	// FailedTasks 是尝试耗尽而失败的任务集合。
	FailedTasks map[TaskID]struct{}
	// Hold 是重放结束时仍未释放的预留资源。
	Hold ResourceSpec
	// Billed 是重放期间累计的计费用量。
	Billed ResourceUsage
	// Placed 与 Released 是累计预留与累计释放量，两者必须相等。
	Placed   ResourceSpec
	Released ResourceSpec
	// Violations 是检测到的不变量违例；为空表示全部通过。
	Violations []string
}

// OK 报告重放是否未发现任何违例。
func (r ReplayReport) OK() bool { return len(r.Violations) == 0 }

type replayAttempt struct {
	id        AttemptID
	task      TaskID
	executor  ExecutorID
	kind      AttemptKind
	startedAt time.Time
	resource  ResourceSpec
	running   bool
	terminal  EventType
	placed    ResourceSpec
	released  ResourceSpec
	billed    ResourceUsage
}

type replayTask struct {
	partition ShufflePartition
	attempts  []*replayAttempt
	committed bool
	failed    bool
	pending   bool
}

type replayExecutor struct {
	lost    bool
	running AttemptID
}

type replayer struct {
	cfg      Config
	report   ReplayReport
	tasks    map[TaskID]*replayTask
	execs    map[ExecutorID]*replayExecutor
	attempts map[AttemptID]*replayAttempt
	history  []time.Duration
	hold     ResourceSpec
	lastSeq  int64
	lastAt   time.Time
}

// Replay 从事件日志确定性地重建协调器状态，并校验三类核心不变量：
//
//  1. 每个 shuffle 分区最多提交一次，提交后到达的结果必须被拒绝；
//  2. 资源计费守恒：hold 永不为负、每个尝试 place==release、累计 place==release；
//  3. 推测副本不得早于慢任务分位数启动，超时不得早于硬超时阈值。
func Replay(events []Event, cfg Config) ReplayReport {
	cfg.normalize()
	r := &replayer{
		cfg:      cfg,
		tasks:    make(map[TaskID]*replayTask),
		execs:    make(map[ExecutorID]*replayExecutor),
		attempts: make(map[AttemptID]*replayAttempt),
		report: ReplayReport{
			CommittedPartitions: make(map[ShufflePartition]AttemptID),
			CommittedTasks:      make(map[TaskID]struct{}),
			FailedTasks:         make(map[TaskID]struct{}),
		},
	}
	for _, ev := range events {
		r.apply(ev)
	}
	r.finalize()
	return r.report
}

// Replay 使用协调器自身的配置与事件日志进行重放。
func (c *Coordinator) Replay() ReplayReport {
	return Replay(c.Events(), c.cfg)
}

func (r *replayer) violation(format string, args ...any) {
	r.report.Violations = append(r.report.Violations, fmt.Sprintf(format, args...))
}

func (r *replayer) apply(ev Event) {
	if ev.Seq != r.lastSeq+1 {
		r.violation("event seq gap: got %d, want %d", ev.Seq, r.lastSeq+1)
	}
	r.lastSeq = ev.Seq
	if !r.lastAt.IsZero() && ev.At.Before(r.lastAt) {
		r.violation("event time went backwards at seq %d", ev.Seq)
	}
	r.lastAt = ev.At

	switch ev.Type {
	case EvExecutorRegistered:
		if _, ok := r.execs[ev.ExecutorID]; ok {
			r.violation("duplicate executor registration: %s", ev.ExecutorID)
			return
		}
		r.execs[ev.ExecutorID] = &replayExecutor{}
	case EvExecutorLost:
		ex := r.requireExecutor(ev)
		if ex == nil {
			return
		}
		if ex.lost {
			r.violation("executor already lost: %s", ev.ExecutorID)
			return
		}
		ex.lost = true
	case EvTaskSubmitted:
		if _, ok := r.tasks[ev.TaskID]; ok {
			r.violation("duplicate task submission: %s", ev.TaskID)
			return
		}
		r.tasks[ev.TaskID] = &replayTask{partition: ev.Partition, pending: true}
	case EvAttemptScheduled:
		r.applyScheduled(ev)
	case EvAttemptSucceeded, EvAttemptFailed, EvAttemptTimedOut, EvAttemptCancelled:
		r.applyTerminal(ev)
	case EvPartitionCommitted:
		r.applyCommitted(ev)
	case EvResultRejected:
		// 拒绝事件本身就是“未重复发布”的证据，仅校验引用完整性。
		if ev.Reason == 0 {
			r.violation("reject event missing reason at seq %d", ev.Seq)
		}
	case EvTaskFailed:
		task := r.requireTask(ev)
		if task == nil {
			return
		}
		if task.committed {
			r.violation("committed task marked failed: %s", ev.TaskID)
			return
		}
		task.failed = true
		task.pending = false
		r.report.FailedTasks[ev.TaskID] = struct{}{}
	case EvHoldPlaced:
		r.applyHold(ev, true)
	case EvHoldReleased:
		r.applyHold(ev, false)
	case EvUsageBilled:
		r.applyBilled(ev)
	default:
		r.violation("unknown event type %d at seq %d", ev.Type, ev.Seq)
	}
}

func (r *replayer) applyScheduled(ev Event) {
	task := r.requireTask(ev)
	ex := r.requireExecutor(ev)
	if task == nil || ex == nil {
		return
	}
	if task.committed || task.failed {
		r.violation("attempt scheduled for terminal task %s at seq %d", ev.TaskID, ev.Seq)
		return
	}
	if _, ok := r.attempts[ev.AttemptID]; ok {
		r.violation("duplicate attempt id: %s", ev.AttemptID)
		return
	}
	if ex.lost {
		r.violation("attempt scheduled on lost executor %s", ev.ExecutorID)
		return
	}
	if ex.running != "" {
		r.violation("executor %s already running attempt %s", ev.ExecutorID, ex.running)
		return
	}
	if len(task.attempts) >= r.cfg.MaxAttempts {
		r.violation("task %s exceeds MaxAttempts %d", ev.TaskID, r.cfg.MaxAttempts)
	}

	att := &replayAttempt{
		id:        ev.AttemptID,
		task:      ev.TaskID,
		executor:  ev.ExecutorID,
		kind:      ev.Kind,
		startedAt: ev.At,
		resource:  ev.Resource,
		running:   true,
	}
	task.attempts = append(task.attempts, att)
	r.attempts[ev.AttemptID] = att
	ex.running = ev.AttemptID
	task.pending = false

	switch ev.Kind {
	case AttemptOriginal, AttemptRetry:
		if ev.Kind == AttemptRetry && len(task.attempts) < 2 {
			r.violation("retry attempt %s scheduled without a predecessor", ev.AttemptID)
		}
	case AttemptSpeculative:
		if !r.hasRunning(task) {
			r.violation("speculative attempt %s has no running predecessor", ev.AttemptID)
		}
		threshold := slowThreshold(r.history, r.cfg)
		if threshold <= 0 {
			r.violation("speculative attempt %s started without sufficient history", ev.AttemptID)
		} else {
			oldest := r.oldestRunning(task)
			if oldest == nil || ev.At.Sub(oldest.startedAt) < threshold {
				r.violation("speculative attempt %s started before slow threshold %s", ev.AttemptID, threshold)
			}
		}
	default:
		r.violation("attempt %s has unknown kind %d", ev.AttemptID, ev.Kind)
	}
}

func (r *replayer) applyTerminal(ev Event) {
	att := r.requireAttempt(ev)
	if att == nil {
		return
	}
	if !att.running {
		r.violation("terminal event for non-running attempt %s at seq %d", ev.AttemptID, ev.Seq)
		return
	}
	att.running = false
	att.terminal = ev.Type
	if ex := r.execs[att.executor]; ex != nil && ex.running == att.id {
		ex.running = ""
	}

	if ev.Type == EvAttemptTimedOut {
		threshold := timeoutThreshold(r.history, r.cfg)
		if threshold <= 0 {
			r.violation("timeout event with hard timeout disabled: %s", ev.AttemptID)
		} else if ev.At.Sub(att.startedAt) < threshold {
			r.violation("attempt %s timed out before hard timeout %s", ev.AttemptID, threshold)
		}
	}
}

func (r *replayer) applyCommitted(ev Event) {
	task := r.requireTask(ev)
	att := r.requireAttempt(ev)
	if task == nil || att == nil {
		return
	}
	if task.committed {
		r.violation("partition %s committed more than once", task.partition)
		return
	}
	if att.terminal != EvAttemptSucceeded {
		r.violation("partition %s committed by non-succeeded attempt %s", task.partition, ev.AttemptID)
		return
	}
	if existing, ok := r.report.CommittedPartitions[task.partition]; ok {
		r.violation("partition %s committed by %s and %s", task.partition, existing, ev.AttemptID)
		return
	}
	task.committed = true
	r.report.CommittedPartitions[task.partition] = ev.AttemptID
	r.report.CommittedTasks[ev.TaskID] = struct{}{}
	r.history = insertSorted(r.history, ev.Runtime)
}

func (r *replayer) applyHold(ev Event, place bool) {
	att := r.requireAttempt(ev)
	if att == nil {
		return
	}
	if place {
		if !att.placed.IsZero() {
			r.violation("attempt %s hold placed twice", ev.AttemptID)
			return
		}
		att.placed = ev.Resource
		r.hold = r.hold.Add(ev.Resource)
		r.report.Placed = r.report.Placed.Add(ev.Resource)
	} else {
		if !att.released.IsZero() {
			r.violation("attempt %s hold released twice", ev.AttemptID)
			return
		}
		att.released = ev.Resource
		r.hold = r.hold.Sub(ev.Resource)
		r.report.Released = r.report.Released.Add(ev.Resource)
	}
	if r.hold.CPUMillis < 0 || r.hold.MemoryMB < 0 {
		r.violation("resource hold went negative at seq %d", ev.Seq)
	}
}

func (r *replayer) applyBilled(ev Event) {
	att := r.requireAttempt(ev)
	if att == nil {
		return
	}
	if ev.Runtime <= 0 {
		r.violation("non-positive billing duration for attempt %s at seq %d", ev.AttemptID, ev.Seq)
		return
	}
	nanos := ev.Runtime.Nanoseconds()
	att.billed.CPUMillisNanos += ev.Resource.CPUMillis * nanos
	att.billed.MemoryMBNanos += ev.Resource.MemoryMB * nanos
	r.report.Billed.CPUMillisNanos += ev.Resource.CPUMillis * nanos
	r.report.Billed.MemoryMBNanos += ev.Resource.MemoryMB * nanos
}

func (r *replayer) finalize() {
	r.report.Hold = r.hold
	for id, att := range r.attempts {
		if att.placed != att.released {
			r.violation("attempt %s hold not conserved: placed=%+v released=%+v", id, att.placed, att.released)
		}
	}
	if r.report.Placed != r.report.Released {
		r.violation("global hold not conserved: placed=%+v released=%+v", r.report.Placed, r.report.Released)
	}
	if !r.hold.IsZero() {
		r.violation("unreleased hold at end of replay: %+v", r.hold)
	}
	for id, task := range r.tasks {
		if !task.committed && !task.failed {
			r.violation("task %s neither committed nor failed at end of replay", id)
		}
	}
}

func (r *replayer) requireTask(ev Event) *replayTask {
	task := r.tasks[ev.TaskID]
	if task == nil {
		r.violation("unknown task %s at seq %d", ev.TaskID, ev.Seq)
	}
	return task
}

func (r *replayer) requireExecutor(ev Event) *replayExecutor {
	ex := r.execs[ev.ExecutorID]
	if ex == nil {
		r.violation("unknown executor %s at seq %d", ev.ExecutorID, ev.Seq)
	}
	return ex
}

func (r *replayer) requireAttempt(ev Event) *replayAttempt {
	att := r.attempts[ev.AttemptID]
	if att == nil {
		r.violation("unknown attempt %s at seq %d", ev.AttemptID, ev.Seq)
	}
	return att
}

func (r *replayer) hasRunning(task *replayTask) bool {
	return r.oldestRunning(task) != nil
}

func (r *replayer) oldestRunning(task *replayTask) *replayAttempt {
	var oldest *replayAttempt
	for _, att := range task.attempts {
		if !att.running {
			continue
		}
		if oldest == nil || att.startedAt.Before(oldest.startedAt) {
			oldest = att
		}
	}
	return oldest
}
