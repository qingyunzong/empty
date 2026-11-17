package formal

import (
	"fmt"
	"sort"
	"time"
)

// ResultValidator 判断任务结果负载是否有效。返回 false 时结果被拒绝，
// 该尝试按失败处理且不会提交任何分区。
type ResultValidator func(taskID TaskID, payload string) bool

// Config 控制协调器的推测与超时策略。所有阈值都由历史成功运行时长的
// 分位数推导，协调器本身不内置时钟或随机源。
type Config struct {
	// MaxAttempts 是单个任务允许的总尝试数（含首次尝试与推测副本）。
	MaxAttempts int
	// SlowQuantile 是触发推测副本的分位数，例如 0.9 表示 p90。
	SlowQuantile float64
	// TimeoutQuantile 与 TimeoutMultiplier 共同推导硬超时；
	// TimeoutMultiplier <= 0 表示禁用硬超时。
	TimeoutQuantile   float64
	TimeoutMultiplier float64
	// MinHistorySamples 是使用分位数前要求的最少历史成功样本数。
	MinHistorySamples int
	// DefaultResource 是任务未显式指定资源时使用的预留量。
	DefaultResource ResourceSpec
	// Validate 可选；为 nil 时所有结果均视为有效。
	Validate ResultValidator
}

// DefaultConfig 返回一套保守的默认策略：最多 3 次尝试、p90 触发推测、
// 禁用硬超时（慢任务不因墙钟被过早判定，只能被推测副本或执行器丢失终结）。
func DefaultConfig() Config {
	return Config{
		MaxAttempts:       3,
		SlowQuantile:      0.9,
		TimeoutQuantile:   0.99,
		TimeoutMultiplier: 0,
		MinHistorySamples: 4,
		DefaultResource:   ResourceSpec{CPUMillis: 1000, MemoryMB: 1024},
	}
}

func (c *Config) normalize() {
	if c.MaxAttempts < 1 {
		c.MaxAttempts = 1
	}
	if c.SlowQuantile <= 0 || c.SlowQuantile > 1 {
		c.SlowQuantile = 0.9
	}
	if c.TimeoutQuantile <= 0 || c.TimeoutQuantile > 1 {
		c.TimeoutQuantile = 0.99
	}
	if c.MinHistorySamples < 1 {
		c.MinHistorySamples = 1
	}
	if c.DefaultResource.IsZero() {
		c.DefaultResource = ResourceSpec{CPUMillis: 1000, MemoryMB: 1024}
	}
}

// TaskSpec 描述待调度任务与其产出的 shuffle 分区。
type TaskSpec struct {
	ID        TaskID
	Partition ShufflePartition
	Resource  ResourceSpec
}

// Result 是执行器回报的任务结果。
type Result struct {
	TaskID    TaskID
	AttemptID AttemptID
	Executor  ExecutorID
	Payload   string
}

type attemptState struct {
	id        AttemptID
	taskID    TaskID
	executor  ExecutorID
	kind      AttemptKind
	startedAt time.Time
	resource  ResourceSpec
	running   bool
	lastBill  time.Time
	// terminal 记录尝试的终结事件类型；0 表示仍在运行。
	terminal EventType
}

type taskState struct {
	spec        TaskSpec
	pending     bool
	committed   bool
	committedBy AttemptID
	failed      bool
	attempts    []*attemptState
}

type executorState struct {
	id      ExecutorID
	lost    bool
	running AttemptID
}

// Coordinator 是供调度器调用的任务协调器。它是确定性的事件溯源状态机：
// 每次状态变更都追加一条 Event，可通过 Replay 完整重建并校验不变量。
type Coordinator struct {
	cfg     Config
	events  []Event
	seq     int64
	tasks   map[TaskID]*taskState
	execs   map[ExecutorID]*executorState
	idle    map[ExecutorID]struct{}
	pending []TaskID
	history []time.Duration
	ledger  holdAccount
}

// NewCoordinator 创建一个使用给定配置的协调器。
func NewCoordinator(cfg Config) *Coordinator {
	cfg.normalize()
	return &Coordinator{
		cfg:   cfg,
		tasks: make(map[TaskID]*taskState),
		execs: make(map[ExecutorID]*executorState),
		idle:  make(map[ExecutorID]struct{}),
	}
}

// Events 返回事件日志的快照副本。
func (c *Coordinator) Events() []Event {
	out := make([]Event, len(c.events))
	copy(out, c.events)
	return out
}

// ResourceHold 返回当前仍被运行中尝试预留的资源总量。
func (c *Coordinator) ResourceHold() ResourceSpec { return c.ledger.hold }

// BilledUsage 返回截至目前累计计费的资源用量。
func (c *Coordinator) BilledUsage() ResourceUsage { return c.ledger.billed }

// History 返回已提交任务成功尝试运行时长的有序副本。
func (c *Coordinator) History() []time.Duration {
	return append([]time.Duration(nil), c.history...)
}

// IsCommitted 报告某个 shuffle 分区是否已提交。
func (c *Coordinator) IsCommitted(partition ShufflePartition) bool {
	for _, t := range c.tasks {
		if t.spec.Partition == partition && t.committed {
			return true
		}
	}
	return false
}

func (c *Coordinator) appendEvent(ev Event) Event {
	c.seq++
	ev.Seq = c.seq
	c.events = append(c.events, ev)
	return ev
}

// RegisterExecutor 注册一个可执行任务的执行器。
func (c *Coordinator) RegisterExecutor(id ExecutorID, at time.Time) {
	if _, ok := c.execs[id]; ok {
		return
	}
	c.execs[id] = &executorState{id: id}
	c.idle[id] = struct{}{}
	c.appendEvent(Event{At: at, Type: EvExecutorRegistered, ExecutorID: id})
	c.schedule(at)
}

// SubmitTask 提交一个待执行任务。重复提交同一 TaskID 会被视为编程错误并 panic。
func (c *Coordinator) SubmitTask(spec TaskSpec, at time.Time) {
	if _, ok := c.tasks[spec.ID]; ok {
		panic(fmt.Sprintf("formal: duplicate task id %q", spec.ID))
	}
	if spec.Resource.IsZero() {
		spec.Resource = c.cfg.DefaultResource
	}
	c.tasks[spec.ID] = &taskState{spec: spec, pending: true}
	c.pending = append(c.pending, spec.ID)
	c.appendEvent(Event{
		At:        at,
		Type:      EvTaskSubmitted,
		TaskID:    spec.ID,
		Partition: spec.Partition,
		Resource:  spec.Resource,
	})
	c.schedule(at)
}

// Tick 推进协调器时钟：对运行中的尝试计费、判定硬超时，并在有空闲
// 执行器时处理待调度任务与推测副本。时间必须单调不减。
func (c *Coordinator) Tick(now time.Time) []Event {
	emitted := c.billRunning(now)
	emitted = append(emitted, c.expireTimeouts(now)...)
	emitted = append(emitted, c.schedule(now)...)
	return emitted
}

func (c *Coordinator) billRunning(now time.Time) []Event {
	var emitted []Event
	ids := make([]ExecutorID, 0, len(c.execs))
	for id := range c.execs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		ex := c.execs[id]
		if ex.lost || ex.running == "" {
			continue
		}
		att := c.attempt(ex.running)
		if att == nil || !att.running {
			continue
		}
		d := now.Sub(att.lastBill)
		if d <= 0 {
			continue
		}
		c.ledger.bill(att.resource, d)
		att.lastBill = now
		emitted = append(emitted, c.appendEvent(Event{
			At:         now,
			Type:       EvUsageBilled,
			TaskID:     att.taskID,
			AttemptID:  att.id,
			ExecutorID: att.executor,
			Resource:   att.resource,
			Runtime:    d,
		}))
	}
	return emitted
}

func (c *Coordinator) expireTimeouts(now time.Time) []Event {
	threshold := timeoutThreshold(c.history, c.cfg)
	if threshold <= 0 {
		return nil
	}
	var emitted []Event
	for _, tid := range c.sortedTaskIDs() {
		task := c.tasks[tid]
		if !c.taskLive(task) {
			continue
		}
		for _, att := range task.attempts {
			if !att.running {
				continue
			}
			if now.Sub(att.startedAt) < threshold {
				continue
			}
			emitted = append(emitted, c.finishAttempt(att, EvAttemptTimedOut, now, 0)...)
			if task.committed || task.failed {
				break
			}
		}
	}
	return emitted
}

// schedule 是确定性的单遍调度入口，按固定顺序处理三类工作：
// 初始待调度任务、失败后的重试、分位数触发的推测副本。
func (c *Coordinator) schedule(now time.Time) []Event {
	var emitted []Event

	// 1. 初始调度：按提交顺序消费 pending 队列。
	kept := c.pending[:0]
	for _, tid := range c.pending {
		task := c.tasks[tid]
		if task == nil || !task.pending || !c.taskLive(task) {
			continue
		}
		if c.idleCount() == 0 {
			kept = append(kept, tid)
			continue
		}
		emitted = append(emitted, c.startAttempt(task, AttemptOriginal, now)...)
		task.pending = false
	}
	c.pending = kept

	// 2. 失败重试与 3. 推测副本：任务按 ID 排序保证确定性。
	for _, tid := range c.sortedTaskIDs() {
		task := c.tasks[tid]
		if !c.taskLive(task) || task.pending {
			continue
		}
		if c.hasRunning(task) {
			if c.idleCount() > 0 && c.canSpeculate(task, now) {
				emitted = append(emitted, c.startAttempt(task, AttemptSpeculative, now)...)
			}
			continue
		}
		if len(task.attempts) < c.cfg.MaxAttempts {
			if c.idleCount() > 0 {
				emitted = append(emitted, c.startAttempt(task, AttemptRetry, now)...)
			}
		} else {
			c.failTask(task, now)
		}
	}
	return emitted
}

func (c *Coordinator) startAttempt(task *taskState, kind AttemptKind, now time.Time) []Event {
	exID := c.takeIdle()
	if exID == "" {
		return nil
	}
	att := &attemptState{
		id:        c.nextAttemptID(task),
		taskID:    task.spec.ID,
		executor:  exID,
		kind:      kind,
		startedAt: now,
		lastBill:  now,
		resource:  task.spec.Resource,
		running:   true,
	}
	task.attempts = append(task.attempts, att)
	ex := c.execs[exID]
	ex.running = att.id

	c.ledger.place(att.resource)
	emitted := []Event{c.appendEvent(Event{
		At:         now,
		Type:       EvAttemptScheduled,
		TaskID:     task.spec.ID,
		AttemptID:  att.id,
		ExecutorID: exID,
		Partition:  task.spec.Partition,
		Kind:       kind,
		Resource:   att.resource,
	})}
	emitted = append(emitted, c.appendEvent(Event{
		At:         now,
		Type:       EvHoldPlaced,
		TaskID:     task.spec.ID,
		AttemptID:  att.id,
		ExecutorID: exID,
		Resource:   att.resource,
	}))
	return emitted
}

// canSpeculate 在存在运行中尝试时判断是否应再加一个推测副本：
// 历史样本足够、未超过尝试上限，且最老的运行中尝试已达到慢任务分位数。
func (c *Coordinator) canSpeculate(task *taskState, now time.Time) bool {
	if len(task.attempts) >= c.cfg.MaxAttempts {
		return false
	}
	threshold := slowThreshold(c.history, c.cfg)
	if threshold <= 0 {
		return false
	}
	oldest := c.oldestRunning(task)
	if oldest == nil {
		return false
	}
	return now.Sub(oldest.startedAt) >= threshold
}

// AttemptSucceeded 处理执行器回报的成功结果。仅当任务尚未提交、
// 尝试仍在运行、执行器匹配且结果通过校验时才会提交分区，
// 随后撤销该任务的其余所有尝试。任何晚到或无效结果都会被拒绝并产生拒绝事件。
func (c *Coordinator) AttemptSucceeded(res Result, at time.Time) []Event {
	task := c.tasks[res.TaskID]
	att := c.findAttempt(res.TaskID, res.AttemptID)
	if att == nil {
		return c.reject(res, at, RejectUnknownAttempt)
	}
	if task.committed {
		return c.reject(res, at, RejectTaskAlreadyCommitted)
	}
	if task == nil || !att.running {
		return c.reject(res, at, RejectAttemptNotRunning)
	}
	if att.executor != res.Executor {
		return c.reject(res, at, RejectExecutorMismatch)
	}
	if c.cfg.Validate != nil && !c.cfg.Validate(res.TaskID, res.Payload) {
		emitted := c.reject(res, at, RejectValidationFailed)
		// 校验失败终结该尝试并释放预留，随后尝试重试，避免任务与资源悬挂。
		emitted = append(emitted, c.finishAttempt(att, EvAttemptFailed, at, 0)...)
		emitted = append(emitted, c.schedule(at)...)
		return emitted
	}

	runtime := at.Sub(att.startedAt)
	emitted := c.finishAttempt(att, EvAttemptSucceeded, at, runtime)

	task.committed = true
	task.committedBy = att.id
	c.history = insertSorted(c.history, runtime)
	emitted = append(emitted, c.appendEvent(Event{
		At:         at,
		Type:       EvPartitionCommitted,
		TaskID:     task.spec.ID,
		AttemptID:  att.id,
		ExecutorID: att.executor,
		Partition:  task.spec.Partition,
		Runtime:    runtime,
	}))

	// 首个有效结果已提交：撤销同一任务的其余运行中尝试，保证分区唯一提交。
	for _, other := range task.attempts {
		if other.running && other.id != att.id {
			emitted = append(emitted, c.finishAttempt(other, EvAttemptCancelled, at, 0)...)
		}
	}
	emitted = append(emitted, c.schedule(at)...)
	return emitted
}

// AttemptFailed 报告一个尝试执行失败（非执行器丢失）。尝试终结后，
// 若任务尚有尝试配额则在有空闲执行器时安排重试，否则任务失败。
func (c *Coordinator) AttemptFailed(taskID TaskID, attemptID AttemptID, at time.Time) []Event {
	att := c.findAttempt(taskID, attemptID)
	if att == nil || !att.running {
		return nil
	}
	emitted := c.finishAttempt(att, EvAttemptFailed, at, 0)
	emitted = append(emitted, c.schedule(at)...)
	return emitted
}

// ExecutorLost 标记执行器丢失并终结其上运行的尝试。丢失的执行器
// 不会归还空闲池，其预留资源立即释放，任务可在其他执行器上重试。
func (c *Coordinator) ExecutorLost(id ExecutorID, at time.Time) []Event {
	ex := c.execs[id]
	if ex == nil || ex.lost {
		return nil
	}
	ex.lost = true
	delete(c.idle, id)
	emitted := []Event{c.appendEvent(Event{At: at, Type: EvExecutorLost, ExecutorID: id})}
	if ex.running != "" {
		if att := c.attempt(ex.running); att != nil && att.running {
			emitted = append(emitted, c.finishAttempt(att, EvAttemptFailed, at, 0)...)
		}
		ex.running = ""
	}
	emitted = append(emitted, c.schedule(at)...)
	return emitted
}

// finishAttempt 终结一个运行中的尝试：补齐最后一段计费、释放预留资源，
// 执行器回到空闲池（执行器丢失路径除外），并写入终结事件与释放事件。
func (c *Coordinator) finishAttempt(att *attemptState, term EventType, at time.Time, runtime time.Duration) []Event {
	if !att.running {
		return nil
	}
	att.running = false
	att.terminal = term

	var emitted []Event
	if d := at.Sub(att.lastBill); d > 0 {
		c.ledger.bill(att.resource, d)
		att.lastBill = at
		emitted = append(emitted, c.appendEvent(Event{
			At:         at,
			Type:       EvUsageBilled,
			TaskID:     att.taskID,
			AttemptID:  att.id,
			ExecutorID: att.executor,
			Resource:   att.resource,
			Runtime:    d,
		}))
	}

	emitted = append(emitted, c.appendEvent(Event{
		At:         at,
		Type:       term,
		TaskID:     att.taskID,
		AttemptID:  att.id,
		ExecutorID: att.executor,
		Kind:       att.kind,
		Runtime:    runtime,
	}))

	c.ledger.release(att.resource)
	emitted = append(emitted, c.appendEvent(Event{
		At:         at,
		Type:       EvHoldReleased,
		TaskID:     att.taskID,
		AttemptID:  att.id,
		ExecutorID: att.executor,
		Resource:   att.resource,
	}))

	if ex := c.execs[att.executor]; ex != nil && !ex.lost {
		ex.running = ""
		c.idle[att.executor] = struct{}{}
	}
	return emitted
}

func (c *Coordinator) failTask(task *taskState, at time.Time) {
	task.failed = true
	c.appendEvent(Event{
		At:        at,
		Type:      EvTaskFailed,
		TaskID:    task.spec.ID,
		Partition: task.spec.Partition,
	})
}

func (c *Coordinator) reject(res Result, at time.Time, reason RejectReason) []Event {
	return []Event{c.appendEvent(Event{
		At:         at,
		Type:       EvResultRejected,
		TaskID:     res.TaskID,
		AttemptID:  res.AttemptID,
		ExecutorID: res.Executor,
		Reason:     reason,
		Payload:    res.Payload,
	})}
}

func (c *Coordinator) taskLive(t *taskState) bool {
	return t != nil && !t.committed && !t.failed
}

func (c *Coordinator) hasRunning(t *taskState) bool {
	return c.oldestRunning(t) != nil
}

func (c *Coordinator) oldestRunning(t *taskState) *attemptState {
	var oldest *attemptState
	for _, att := range t.attempts {
		if !att.running {
			continue
		}
		if oldest == nil || att.startedAt.Before(oldest.startedAt) {
			oldest = att
		}
	}
	return oldest
}

func (c *Coordinator) findAttempt(taskID TaskID, attemptID AttemptID) *attemptState {
	if t := c.tasks[taskID]; t != nil {
		for _, att := range t.attempts {
			if att.id == attemptID {
				return att
			}
		}
	}
	return nil
}

func (c *Coordinator) attempt(id AttemptID) *attemptState {
	for _, t := range c.tasks {
		for _, att := range t.attempts {
			if att.id == id {
				return att
			}
		}
	}
	return nil
}

func (c *Coordinator) nextAttemptID(t *taskState) AttemptID {
	return AttemptID(fmt.Sprintf("%s#%d", t.spec.ID, len(t.attempts)+1))
}

func (c *Coordinator) idleCount() int { return len(c.idle) }

// takeIdle 确定性地选取 ID 最小的空闲执行器，避免 map 遍历的随机顺序。
func (c *Coordinator) takeIdle() ExecutorID {
	if len(c.idle) == 0 {
		return ""
	}
	ids := make([]ExecutorID, 0, len(c.idle))
	for id := range c.idle {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	id := ids[0]
	delete(c.idle, id)
	return id
}

func (c *Coordinator) sortedTaskIDs() []TaskID {
	ids := make([]TaskID, 0, len(c.tasks))
	for id := range c.tasks {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}
